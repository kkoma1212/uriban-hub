import {
  securityAuditDeduplicationScope as deduplicationScope,
  type SecurityAuditDeduplicationScope as DeduplicationScope,
  type DB,
  type SecurityAuditEvent,
} from "@classhub/db";
import { sql, type Kysely } from "kysely";
import type { SecurityAuditStore } from "./security-audit-store.js";

/** PostgreSQL persistence extracted without changing its SQL or transaction boundaries. */
export class PostgresSecurityAuditStore implements SecurityAuditStore {
  constructor(private readonly database: Kysely<DB>) {}

  async insertEvent(event: SecurityAuditEvent): Promise<void> {
    const scope = deduplicationScope(event);
    if (scope === null) {
      await this.insertEventRow(this.database, event);
      return;
    }

    await this.database.transaction().execute(async (transaction) => {
      await this.acquireDeduplicationLock(transaction, scope);
      if (!(await this.hasDeduplicationMatch(transaction, event, scope))) {
        await this.insertEventRow(transaction, event);
      }
    });
  }

  private async acquireDeduplicationLock(
    database: Kysely<DB>,
    scope: DeduplicationScope,
  ): Promise<void> {
    await sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${scope.identity}, 0::bigint)
      )
    `.execute(database);
  }

  private async hasDeduplicationMatch(
    database: Kysely<DB>,
    event: SecurityAuditEvent,
    scope: DeduplicationScope,
  ): Promise<boolean> {
    const occurredAt = new Date(event.occurred_at).getTime();
    const windowStart = new Date(occurredAt - scope.windowMs);
    const windowEnd = new Date(occurredAt + scope.windowMs);
    const existing =
      event.action === "authz.denied"
        ? await database
            .selectFrom("security_audit_logs")
            .select("event_id")
            .where("action", "=", event.action)
            .where("created_at", ">", windowStart)
            .where("created_at", "<", windowEnd)
            .where(sql<boolean>`actor_user_id IS NOT DISTINCT FROM ${event.actor_user_id}::bigint`)
            .where(sql<boolean>`actor_ip IS NOT DISTINCT FROM ${event.actor_ip}::inet`)
            .where(
              sql<boolean>`target_class_id IS NOT DISTINCT FROM ${event.target_class_id}::bigint`,
            )
            .where(sql<boolean>`resource IS NOT DISTINCT FROM ${event.resource}::text`)
            .where(sql<boolean>`deny_reason IS NOT DISTINCT FROM ${event.deny_reason}::text`)
            .executeTakeFirst()
        : event.action === "auth.csrf_failed"
          ? await database
              .selectFrom("security_audit_logs")
              .select("event_id")
              .where("action", "=", event.action)
              .where("created_at", ">", windowStart)
              .where("created_at", "<", windowEnd)
              .where(
                sql<boolean>`actor_user_id IS NOT DISTINCT FROM ${event.actor_user_id}::bigint`,
              )
              .where(sql<boolean>`actor_ip IS NOT DISTINCT FROM ${event.actor_ip}::inet`)
              .where(
                sql<boolean>`target_class_id IS NOT DISTINCT FROM ${event.target_class_id}::bigint`,
              )
              .where("method", "=", event.method)
              .where("sanitized_path", "=", event.sanitized_path)
              .where(sql<boolean>`deny_reason IS NOT DISTINCT FROM ${event.deny_reason}::text`)
              .executeTakeFirst()
          : await database
              .selectFrom("security_audit_logs")
              .select("event_id")
              .where("action", "=", event.action)
              .where("created_at", ">", windowStart)
              .where("created_at", "<", windowEnd)
              .where(sql<boolean>`actor_ip IS NOT DISTINCT FROM ${event.actor_ip}::inet`)
              .where("method", "=", event.method)
              .where("sanitized_path", "=", event.sanitized_path)
              .where(sql<boolean>`deny_reason IS NOT DISTINCT FROM ${event.deny_reason}::text`)
              .executeTakeFirst();

    return existing !== undefined;
  }

  private async insertEventRow(database: Kysely<DB>, event: SecurityAuditEvent): Promise<void> {
    await database
      .insertInto("security_audit_logs")
      .values({
        action: event.action,
        actor_class_id: event.actor_class_id,
        actor_email_hmac: event.actor_email_hmac,
        actor_ip: event.actor_ip,
        actor_user_id: event.actor_user_id,
        created_at: new Date(event.occurred_at),
        deny_reason: event.deny_reason,
        event_id: event.event_id,
        failure_code: event.failure_code,
        hmac_key_version: event.hmac_key_version,
        method: event.method,
        request_id: event.request_id,
        resource: event.resource,
        sanitized_path: event.sanitized_path,
        target_class_id: event.target_class_id,
        user_agent: event.user_agent,
      })
      .onConflict((conflict) => conflict.column("event_id").doNothing())
      .execute();
  }

  async isEventAlreadyHandled(event: SecurityAuditEvent): Promise<boolean> {
    const scope = deduplicationScope(event);
    if (scope === null) {
      return (
        (await this.database
          .selectFrom("security_audit_logs")
          .select("event_id")
          .where("event_id", "=", event.event_id)
          .executeTakeFirst()) !== undefined
      );
    }

    return this.database.transaction().execute(async (transaction) => {
      await this.acquireDeduplicationLock(transaction, scope);

      const exactEvent = await transaction
        .selectFrom("security_audit_logs")
        .select("event_id")
        .where("event_id", "=", event.event_id)
        .executeTakeFirst();
      return (
        exactEvent !== undefined || (await this.hasDeduplicationMatch(transaction, event, scope))
      );
    });
  }
}
