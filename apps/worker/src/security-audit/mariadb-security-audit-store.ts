import { types } from "node:util";
import {
  createMariaDbWorkerAuditLockManager,
  securityAuditDeduplicationScope,
  validateSecurityAuditEvent,
  type DB,
  type MariaDbWorkerAuditLockManager,
  type SecurityAuditDeduplicationScope,
  type SecurityAuditEvent,
} from "@classhub/db";
import { sql, type Kysely } from "kysely";
import type { SecurityAuditStore } from "./security-audit-store.js";
import {
  classifySecurityAuditStoreFailure,
  type SecurityAuditStoreFailureReason,
} from "./store-failure.js";

export class MariaDbSecurityAuditStoreError extends Error {
  readonly code = "MARIADB_SECURITY_AUDIT_STORE_FAILED";
  constructor(readonly failureReason: SecurityAuditStoreFailureReason = "unknown") {
    super("보안 감사 이벤트 저장 상태를 확인하지 못했습니다.");
    this.name = "MariaDbSecurityAuditStoreError";
  }
}

function occurredAt(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "000");
}

function duplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    !types.isProxy(error) &&
    Object.getOwnPropertyDescriptor(error, "errno")?.value === 1062 &&
    Object.getOwnPropertyDescriptor(error, "sqlState")?.value === "23000"
  );
}

/** Opt-in store. No Redis retry/ACK policy or runtime database selection changes here. */
export class MariaDbSecurityAuditStore implements SecurityAuditStore {
  constructor(
    private readonly database: Kysely<DB>,
    private readonly locks: MariaDbWorkerAuditLockManager<DB> = createMariaDbWorkerAuditLockManager<DB>(),
  ) {}

  async insertEvent(input: SecurityAuditEvent): Promise<void> {
    try {
      const event = validateSecurityAuditEvent(input);
      const scope = securityAuditDeduplicationScope(event);
      // Registration completes and returns its lease before opening the business transaction.
      const handle =
        scope === null ? undefined : await this.locks.prepare(this.database, scope.identity);
      let insertConflict: unknown;
      try {
        await this.database.transaction().execute(async (transaction) => {
          if (handle !== undefined) await this.locks.acquire(transaction, handle);
          if (scope !== null && (await this.hasDeduplicationMatch(transaction, event, scope)))
            return;
          try {
            await this.insertEventRow(transaction, event);
          } catch (error) {
            if (duplicateKey(error)) insertConflict = error;
            throw error;
          }
        });
      } catch (error) {
        // Ignore only INSERT's native duplicate after successful whole-transaction rollback.
        // A rollback/COMMIT failure or unrelated constraint never becomes an acknowledgement.
        if (
          insertConflict !== undefined &&
          error === insertConflict &&
          (await this.hasExactEvent(this.database, event.event_id))
        )
          return;
        throw error;
      }
    } catch (error) {
      throw new MariaDbSecurityAuditStoreError(classifySecurityAuditStoreFailure(error));
    }
  }

  async isEventAlreadyHandled(input: SecurityAuditEvent): Promise<boolean> {
    try {
      const event = validateSecurityAuditEvent(input);
      const scope = securityAuditDeduplicationScope(event);
      if (scope === null) return await this.hasExactEvent(this.database, event.event_id);
      const handle = await this.locks.prepare(this.database, scope.identity);
      return await this.database.transaction().execute(async (transaction) => {
        await this.locks.acquire(transaction, handle);
        return (
          (await this.hasExactEvent(transaction, event.event_id)) ||
          (await this.hasDeduplicationMatch(transaction, event, scope))
        );
      });
    } catch (error) {
      throw new MariaDbSecurityAuditStoreError(classifySecurityAuditStoreFailure(error));
    }
  }

  private async hasExactEvent(database: Kysely<DB>, eventId: string): Promise<boolean> {
    const result = await sql<{ event_id: string }>`
      SELECT event_id FROM security_audit_logs WHERE event_id = ${eventId} LIMIT 1
    `.execute(database);
    return result.rows.length > 0;
  }

  private async hasDeduplicationMatch(
    database: Kysely<DB>,
    event: SecurityAuditEvent,
    scope: SecurityAuditDeduplicationScope,
  ): Promise<boolean> {
    const timestamp = new Date(event.occurred_at).getTime();
    const predicates = [
      sql`BINARY action = BINARY ${event.action}`,
      sql`created_at > ${occurredAt(new Date(timestamp - scope.windowMs))}`,
      sql`created_at < ${occurredAt(new Date(timestamp + scope.windowMs))}`,
      sql`actor_ip <=> INET6_NTOA(INET6_ATON(${event.actor_ip}))`,
      sql`BINARY deny_reason <=> BINARY ${event.deny_reason}`,
    ];
    if (event.action === "authz.denied" || event.action === "auth.csrf_failed") {
      predicates.push(
        sql`actor_user_id <=> ${event.actor_user_id}`,
        sql`target_class_id <=> ${event.target_class_id}`,
      );
    }
    if (event.action === "authz.denied") {
      predicates.push(sql`BINARY resource <=> BINARY ${event.resource}`);
    } else {
      predicates.push(
        sql`BINARY method = BINARY ${event.method}`,
        sql`BINARY sanitized_path = BINARY ${event.sanitized_path}`,
      );
    }
    const result = await sql<{ event_id: string }>`
      SELECT event_id FROM security_audit_logs WHERE ${sql.join(predicates, sql` AND `)} LIMIT 1
    `.execute(database);
    return result.rows.length > 0;
  }

  private async insertEventRow(database: Kysely<DB>, event: SecurityAuditEvent): Promise<void> {
    // INET textual normalization is performed by the same server function as the column CHECK.
    // UUID/HMAC/IDs retain their original values; PG event ISO milliseconds map to DB6 ...000.
    await sql`
      INSERT INTO security_audit_logs
        (action,actor_class_id,actor_email_hmac,actor_ip,actor_user_id,created_at,
         deny_reason,event_id,failure_code,hmac_key_version,method,request_id,resource,
         sanitized_path,target_class_id,user_agent)
      VALUES (${event.action},${event.actor_class_id},${event.actor_email_hmac},
        INET6_NTOA(INET6_ATON(${event.actor_ip})),${event.actor_user_id},
        ${occurredAt(new Date(event.occurred_at))},${event.deny_reason},${event.event_id},
        ${event.failure_code},${event.hmac_key_version},${event.method},${event.request_id},
        ${event.resource},${event.sanitized_path},${event.target_class_id},${event.user_agent})
    `.execute(database);
  }
}
