import { createHash } from "node:crypto";

import { matchesDatabaseConstraint, type DB, type JsonValue } from "@classhub/db";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql, type Selectable, type Transaction } from "kysely";

import { adminAuthDate, adminAuthJson } from "../admin-auth/admin-auth.database.js";
import {
  invalidateRequestLimitPolicy,
  parseRequestLimitPolicy,
} from "../common/rate-limit/request-limit-policy.js";
import { countCodePoints, isAllowedPlainText } from "../common/validation/text-validation.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import {
  AdminTermsInsertCollision,
  adminManagementMariaDbCodec,
  isAdminManagementNativeError,
  lockAdminManagementMutation,
  transitionMariaDbAdminMember,
} from "./admin-management.database.js";
import type { AdminLegalDocumentType } from "./admin-management.dto.js";
import { adminError } from "./admin-error.js";

function containsUnresolvedLegalPlaceholder(content: string): boolean {
  return /\[게시본 주입|\[게시 전 확정|개발 정본/u.test(content);
}

const MAX_DATABASE_ID = 9_223_372_036_854_775_807n;

function isDatabaseId(value: string): boolean {
  if (!/^[1-9]\d*$/u.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= MAX_DATABASE_ID;
  } catch {
    return false;
  }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

function termsVersionView<T extends { content_sha256: Buffer }>(row: T) {
  return { ...row, content_sha256: row.content_sha256.toString("hex") };
}

const AUDIT_PAGE_SIZE = 50;

@Injectable()
export class AdminManagementService {
  private readonly db: ClassHubDatabase;
  private readonly engine: "postgres" | "mariadb";

  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    config: ConfigService<AppEnvironment, true>,
  ) {
    const engine = config.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
    if (engine !== "postgres" && engine !== "mariadb")
      throw new Error("Invalid administrator management database engine.");
    this.engine = engine;
    this.db = engine === "mariadb" ? database.withPlugin(adminManagementMariaDbCodec) : database;
  }

  async listMembers(query: { search: string; status?: string }) {
    const search = query.search.normalize("NFC").trim();
    if ([...search].length < 2 || [...search].length > 100) {
      throw adminError(BadRequestException, "ADMIN_MEMBER_FILTER_REQUIRED");
    }
    let q = this.db
      .selectFrom("class_members as m")
      .innerJoin("users as u", "u.id", "m.user_id")
      // 어느 반 소속인지 카드에 보이게 반·학교 이름을 함께 읽는다(총검수 C2-08).
      .innerJoin("classes as c", "c.id", "m.class_id")
      .leftJoin("schools as s", (join) =>
        join
          .onRef("s.edu_office_code", "=", "c.edu_office_code")
          .onRef("s.school_code", "=", "c.school_code"),
      )
      .select([
        "m.id",
        "m.class_id",
        "m.role",
        "m.status",
        "m.student_number",
        "m.display_name_in_class",
        "m.status_changed_at",
        "u.display_name",
        "u.email_normalized",
        "u.is_active",
        "u.deleted_at",
        "c.name as class_name",
        "c.academic_year",
        "c.grade",
        "s.school_name",
      ])
      .orderBy("m.status_changed_at", "desc")
      .limit(101);
    if (query.status) q = q.where("m.status", "=", query.status);
    const pattern = `%${escapeLikePattern(search)}%`;
    q = q.where((eb) =>
      this.engine === "mariadb"
        ? sql<boolean>`(LOWER(u.email_normalized) LIKE LOWER(${pattern}) ESCAPE ${"\\"}
          OR LOWER(u.display_name) LIKE LOWER(${pattern}) ESCAPE ${"\\"})`
        : eb.or([
            eb("u.email_normalized", "ilike", pattern),
            eb("u.display_name", "ilike", pattern),
          ]),
    );
    const rows = await q.execute();
    return {
      truncated: rows.length > 100,
      members: rows.slice(0, 100).map((r) => ({
        id: r.id,
        class_id: r.class_id,
        role: r.role,
        status: r.status,
        student_number: r.student_number,
        display_name: r.display_name_in_class ?? r.display_name,
        email: r.email_normalized,
        account_active: r.is_active && r.deleted_at === null,
        status_changed_at: r.status_changed_at.toISOString(),
        class_label: `${r.academic_year}학년도 ${r.grade}학년 ${r.class_name}`,
        school_name: r.school_name ?? null,
      })),
    };
  }

  async updateMember(
    id: string,
    status: string,
    reason: string | undefined,
    adminId: string,
    requestId: string,
  ) {
    if (!isDatabaseId(id)) throw adminError(NotFoundException, "MEMBER_NOT_FOUND");
    const identity = await this.db
      .selectFrom("class_members")
      .select(["class_id", "id", "user_id"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (identity === undefined) throw adminError(NotFoundException, "MEMBER_NOT_FOUND");

    return this.db.transaction().execute(async (tx) => {
      const account = await tx
        .selectFrom("users")
        .select(["deleted_at", "display_name", "is_active"])
        .where("id", "=", identity.user_id)
        .forUpdate()
        .executeTakeFirst();
      if (account === undefined) throw adminError(NotFoundException, "MEMBER_NOT_FOUND");
      const targetClass = await tx
        .selectFrom("classes")
        .select(["id", "status"])
        .where("id", "=", identity.class_id)
        .forUpdate()
        .executeTakeFirst();
      if (targetClass === undefined || targetClass.status !== "active") {
        throw adminError(BadRequestException, "ADMIN_MEMBER_CLASS_NOT_ACTIVE");
      }
      const member = await tx
        .selectFrom("class_members")
        .selectAll()
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (member === undefined || member.role !== "student") {
        throw adminError(NotFoundException, "MEMBER_NOT_FOUND");
      }
      if (
        this.engine === "mariadb" &&
        (member.id !== identity.id ||
          member.class_id !== identity.class_id ||
          member.user_id !== identity.user_id)
      )
        throw adminError(NotFoundException, "MEMBER_NOT_FOUND");
      const expectedStatus = {
        approved: "pending",
        rejected: "pending",
        rejoin_allowed: "removed",
        removed: "approved",
      }[status];
      if (expectedStatus === undefined || member.status !== expectedStatus) {
        throw adminError(BadRequestException, "ADMIN_MEMBER_STATUS_TRANSITION_INVALID");
      }
      if (status === "approved" && (!account.is_active || account.deleted_at !== null)) {
        throw adminError(BadRequestException, "ADMIN_MEMBER_ACCOUNT_INACTIVE");
      }
      const normalizedReason = reason?.trim() || null;
      if (status !== "approved" && normalizedReason === null) {
        throw adminError(BadRequestException, "ADMIN_MEMBER_REASON_REQUIRED");
      }
      const previousReason =
        (
          await tx
            .selectFrom("class_member_status_history")
            .select("reason")
            .where("member_id", "=", member.id)
            .where("to_status", "=", expectedStatus)
            .orderBy("created_at", "desc")
            .orderBy("id", "desc")
            .executeTakeFirst()
        )?.reason ?? null;
      const now = new Date();
      const updated =
        this.engine === "mariadb"
          ? await transitionMariaDbAdminMember(tx, member, status, normalizedReason, adminId, now)
          : await tx
              .updateTable("class_members")
              .set({
                ...(status === "removed" ? { student_number: null } : {}),
                status,
                status_changed_at: now,
                row_version: sql`row_version + 1`,
                updated_at: now,
              })
              .where("id", "=", id)
              .where("status", "=", expectedStatus)
              .returning(["id", "status", "row_version", "status_changed_at"])
              .executeTakeFirst();
      if (updated === undefined) {
        throw adminError(BadRequestException, "ADMIN_MEMBER_STATUS_TRANSITION_INVALID");
      }

      if (status === "approved") {
        await tx.deleteFrom("notice_reads").where("member_id", "=", member.id).execute();
        await tx.deleteFrom("supply_checks").where("member_id", "=", member.id).execute();
      }
      if (status === "removed" && this.engine === "postgres") {
        const seatAssignmentsTable = await sql<{ exists: boolean }>`
          SELECT to_regclass('public.seat_draw_assignments') IS NOT NULL AS exists
        `.execute(tx);
        if (seatAssignmentsTable.rows[0]?.exists) {
          await tx.deleteFrom("seat_draw_assignments").where("member_id", "=", member.id).execute();
        }
        const teamAssignmentsTable = await sql<{ exists: boolean }>`
          SELECT to_regclass('public.team_draw_assignments') IS NOT NULL AS exists
        `.execute(tx);
        if (teamAssignmentsTable.rows[0]?.exists) {
          await tx.deleteFrom("team_draw_assignments").where("member_id", "=", member.id).execute();
        }
        const dutyAssignmentsTable = await sql<{ exists: boolean }>`
          SELECT to_regclass('public.duty_assignments') IS NOT NULL AS exists
        `.execute(tx);
        if (dutyAssignmentsTable.rows[0]?.exists) {
          await tx.deleteFrom("duty_assignments").where("member_id", "=", member.id).execute();
        }
      }

      if (this.engine === "postgres")
        await tx
          .insertInto("class_member_status_history")
          .values({
            actor_admin_account_id: adminId,
            actor_member_id: null,
            actor_operator_id: null,
            actor_user_id: null,
            class_id: member.class_id,
            from_status: expectedStatus,
            member_id: member.id,
            reason: normalizedReason,
            to_status: status,
          })
          .execute();
      const displayName = member.display_name_in_class ?? account.display_name;
      const action = `member.${status}` as const;
      await tx
        .insertInto("audit_logs")
        .values({
          action,
          actor_display_name_snapshot: "administrator",
          actor_member_id: null,
          actor_role_snapshot: "operator",
          actor_user_id: null,
          after_json: adminAuthJson(
            {
              display_name_snapshot: displayName,
              member_id: id,
              reason: normalizedReason,
              role: member.role,
              status,
            },
            this.engine,
          ),
          before_json: adminAuthJson(
            {
              display_name_snapshot: displayName,
              member_id: id,
              reason: previousReason,
              role: member.role,
              status: member.status,
            },
            this.engine,
          ),
          class_id: member.class_id,
          reason: normalizedReason,
          request_id: requestId,
          target_id: id,
          target_snapshot: null,
          target_type: "member",
        })
        .execute();
      await this.writeOperationAudit(
        tx,
        adminId,
        "admin.member.status_changed",
        "member",
        id,
        { status: member.status },
        { status },
        normalizedReason,
        requestId,
      );
      return { member: updated, changed_by_admin_id: adminId };
    });
  }

  /** 한국 날짜 기간을 UTC 시각 범위로(끝 날짜는 그날 끝까지). */
  private auditPeriod(query: { from?: string; to?: string }) {
    const from = query.from === undefined ? undefined : new Date(`${query.from}T00:00:00+09:00`);
    const to =
      query.to === undefined
        ? undefined
        : new Date(new Date(`${query.to}T00:00:00+09:00`).getTime() + 86_400_000);
    if (
      (from !== undefined && !Number.isFinite(from.getTime())) ||
      (to !== undefined && !Number.isFinite(to.getTime()))
    )
      throw adminError(BadRequestException, "ADMIN_AUDIT_PERIOD_INVALID");
    return { from, to };
  }

  /** 50건씩 넘긴다. 한 건 더 읽어 다음 묶음이 있는지 알린다(총검수 C2-07). */
  private auditPage<T>(rows: T[]) {
    return { logs: rows.slice(0, AUDIT_PAGE_SIZE), has_more: rows.length > AUDIT_PAGE_SIZE };
  }

  async listAudits(query: {
    action?: string;
    resource?: string;
    target?: string;
    from?: string;
    to?: string;
    offset?: string;
  }) {
    const { from, to } = this.auditPeriod(query);
    let q = this.db
      .selectFrom("security_audit_logs")
      .select([
        "id",
        "event_id",
        "action",
        "method",
        "resource",
        "sanitized_path",
        "deny_reason",
        "failure_code",
        "created_at",
        "request_id",
        "target_class_id",
      ])
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(AUDIT_PAGE_SIZE + 1)
      .offset(Number(query.offset ?? 0));
    if (query.action) q = q.where("action", "=", query.action);
    if (query.resource) q = q.where("resource", "=", query.resource);
    if (query.target) q = q.where("target_class_id", "=", query.target);
    if (from) q = q.where("created_at", ">=", adminAuthDate(from, this.engine));
    if (to) q = q.where("created_at", "<", adminAuthDate(to, this.engine));
    return this.auditPage(await q.execute());
  }

  async listOperationAudits(
    query: {
      action?: string;
      actor?: string;
      target?: string;
      from?: string;
      to?: string;
      offset?: string;
    } = {},
  ) {
    const { from, to } = this.auditPeriod(query);
    let q = this.db
      .selectFrom("admin_operation_audit_logs as log")
      .leftJoin("admin_accounts as actor", "actor.id", "log.actor_admin_account_id")
      .selectAll("log")
      // 행위자를 숫자 ID만이 아니라 이름으로도 보인다(총검수 C2-07).
      .select("actor.display_name as actor_display_name")
      .orderBy("log.created_at", "desc")
      .orderBy("log.id", "desc")
      .limit(AUDIT_PAGE_SIZE + 1)
      .offset(Number(query.offset ?? 0));
    if (query.action !== undefined) q = q.where("log.action", "=", query.action);
    if (query.actor !== undefined) q = q.where("log.actor_admin_account_id", "=", query.actor);
    if (query.target !== undefined) q = q.where("log.target_id", "=", query.target);
    if (from) q = q.where("log.created_at", ">=", adminAuthDate(from, this.engine));
    if (to) q = q.where("log.created_at", "<", adminAuthDate(to, this.engine));
    return this.auditPage(await q.execute());
  }

  async listAdminAuthAudits(
    query: { action?: string; actor?: string; from?: string; to?: string; offset?: string } = {},
  ) {
    const { from, to } = this.auditPeriod(query);
    let q = this.db
      .selectFrom("admin_auth_audit_logs as log")
      .leftJoin("admin_accounts as actor", "actor.id", "log.admin_account_id")
      .select([
        "log.id",
        "log.event_id",
        "log.admin_account_id",
        "log.action",
        "log.deny_reason",
        "log.request_id",
        "log.created_at",
        "actor.display_name as actor_display_name",
      ])
      .orderBy("log.created_at", "desc")
      .orderBy("log.id", "desc")
      .limit(AUDIT_PAGE_SIZE + 1)
      .offset(Number(query.offset ?? 0));
    if (query.action !== undefined) q = q.where("log.action", "=", query.action);
    if (query.actor !== undefined) q = q.where("log.admin_account_id", "=", query.actor);
    if (from) q = q.where("log.created_at", ">=", adminAuthDate(from, this.engine));
    if (to) q = q.where("log.created_at", "<", adminAuthDate(to, this.engine));
    return this.auditPage(await q.execute());
  }

  async createTermsVersion(
    input: {
      document_type: AdminLegalDocumentType;
      policy_version: string;
      title: string;
      content: string;
    },
    adminId: string,
    requestId: string,
  ) {
    const contentSha256 = createHash("sha256").update(input.content, "utf8").digest();
    try {
      return await this.db.transaction().execute(async (transaction) => {
        const insert = transaction.insertInto("admin_terms_versions").values({
          ...input,
          content_sha256: contentSha256,
          created_by_admin_account_id: adminId,
        });
        let row: Selectable<DB["admin_terms_versions"]>;
        if (this.engine === "mariadb") {
          try {
            const result = await insert.executeTakeFirstOrThrow();
            if (result.numInsertedOrUpdatedRows !== 1n)
              throw new Error("Unexpected administrator terms insert result.");
          } catch (error) {
            if (isAdminManagementNativeError(error, 1062, "23000"))
              throw new AdminTermsInsertCollision(error);
            throw error;
          }
          // UUID is database-owned: the existing exact document/version UNIQUE
          // key identifies this row without granting application INSERT(id).
          row = await transaction
            .selectFrom("admin_terms_versions")
            .selectAll()
            .where("document_type", "=", input.document_type)
            .where("policy_version", "=", input.policy_version)
            .executeTakeFirstOrThrow();
        } else {
          row = await insert.returningAll().executeTakeFirstOrThrow();
        }
        await this.writeOperationAudit(
          transaction,
          adminId,
          "admin.terms.created",
          "terms_version",
          row.id,
          null,
          {
            content_sha256: contentSha256.toString("hex"),
            document_type: row.document_type,
            policy_version: row.policy_version,
            status: row.status,
          },
          null,
          requestId,
        );
        return { version: termsVersionView(row) };
      });
    } catch (error) {
      if (error instanceof AdminTermsInsertCollision) {
        // INSERT-only collision handling; release the failed transaction before
        // checking its identity. Never reinterpret an audit/COMMIT failure.
        const existing = await this.db
          .selectFrom("admin_terms_versions")
          .select("id")
          .where("document_type", "=", input.document_type)
          .where("policy_version", "=", input.policy_version)
          .executeTakeFirst();
        if (existing !== undefined) throw adminError(ConflictException, "TERMS_VERSION_EXISTS");
        throw error.insertError;
      }
      if (
        this.engine === "postgres" &&
        matchesDatabaseConstraint(error, {
          kind: "unique_violation",
          objectName: "admin_terms_versions_document_version_unique",
        })
      ) {
        throw adminError(ConflictException, "TERMS_VERSION_EXISTS");
      }
      throw error;
    }
  }

  async updateTermsVersionStatus(
    id: string,
    status: "published" | "retired",
    effectiveAt: string | undefined,
    reason: string,
    adminId: string,
    requestId: string,
  ) {
    if (
      (status === "published" && effectiveAt === undefined) ||
      (status === "retired" && effectiveAt !== undefined)
    ) {
      throw adminError(BadRequestException, "TERMS_VERSION_EFFECTIVE_AT_INVALID");
    }
    const effectiveDate = effectiveAt === undefined ? undefined : new Date(effectiveAt);
    if (effectiveDate !== undefined && !Number.isFinite(effectiveDate.getTime())) {
      throw adminError(BadRequestException, "TERMS_VERSION_EFFECTIVE_AT_INVALID");
    }
    if (effectiveDate !== undefined && effectiveDate.getTime() > Date.now()) {
      throw adminError(BadRequestException, "TERMS_VERSION_EFFECTIVE_AT_FUTURE");
    }

    return this.db.transaction().execute(async (transaction) => {
      if (this.engine === "mariadb") await lockAdminManagementMutation(transaction);
      const current = await transaction
        .selectFrom("admin_terms_versions")
        .selectAll()
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (current === undefined) throw adminError(NotFoundException, "TERMS_VERSION_NOT_FOUND");
      if (
        status === "published" &&
        containsUnresolvedLegalPlaceholder(current.content + current.title)
      ) {
        throw adminError(BadRequestException, "TERMS_VERSION_HAS_UNRESOLVED_PLACEHOLDER");
      }
      const validTransition =
        (current.status === "draft" && status === "published") ||
        (current.status === "published" && status === "retired");
      if (!validTransition)
        throw adminError(BadRequestException, "TERMS_VERSION_TRANSITION_INVALID");

      if (this.engine === "postgres")
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-terms:${current.document_type}`}, 0))`.execute(
          transaction,
        );
      const now = new Date();
      if (status === "retired") {
        // 가입·동의는 네 문서 모두 지금 시행 중인 게시본이 있어야 한다. 대체본 없이 폐기하면
        // 신규 가입이 전부 막힌다(총검수 C2-04). 교체는 새 버전 게시(이전 게시본 자동 폐기)로 한다.
        const replacements = await transaction
          .selectFrom("admin_terms_versions")
          .select(["effective_at", "published_at"])
          .where("document_type", "=", current.document_type)
          .where("status", "=", "published")
          .where("id", "!=", id)
          .execute();
        const hasEffectiveReplacement = replacements.some(
          (row) =>
            row.effective_at !== null &&
            row.published_at !== null &&
            row.effective_at.getTime() <= now.getTime() &&
            row.published_at.getTime() <= now.getTime(),
        );
        if (!hasEffectiveReplacement)
          throw adminError(ConflictException, "TERMS_VERSION_REPLACEMENT_REQUIRED");
      }
      const automaticallyRetired: Array<{ id: string }> = [];
      if (status === "published") {
        const retire = transaction
          .updateTable("admin_terms_versions")
          .set({ status: "retired" })
          .where("document_type", "=", current.document_type)
          .where("status", "=", "published")
          .where("id", "!=", id);
        if (this.engine === "mariadb") {
          automaticallyRetired.push(
            ...(await transaction
              .selectFrom("admin_terms_versions")
              .select("id")
              .where("document_type", "=", current.document_type)
              .where("status", "=", "published")
              .where("id", "!=", id)
              .orderBy("id")
              .forUpdate()
              .execute()),
          );
          const result = await retire.executeTakeFirstOrThrow();
          if (result.numUpdatedRows !== BigInt(automaticallyRetired.length))
            throw new Error("Unexpected administrator terms retirement result.");
        } else {
          automaticallyRetired.push(...(await retire.returning(["id"]).execute()));
        }
      }
      const update = transaction
        .updateTable("admin_terms_versions")
        .set(
          this.engine === "mariadb" && status === "retired"
            ? { status }
            : {
                status,
                effective_at: adminAuthDate(
                  status === "published" ? effectiveDate! : current.effective_at,
                  this.engine,
                ),
                published_at: adminAuthDate(
                  status === "published" ? now : current.published_at,
                  this.engine,
                ),
              },
        )
        .where("id", "=", id);
      let updated: Selectable<DB["admin_terms_versions"]>;
      if (this.engine === "mariadb") {
        const result = await update.executeTakeFirstOrThrow();
        if (result.numUpdatedRows !== 1n)
          throw new Error("Unexpected administrator terms status update result.");
        updated = await transaction
          .selectFrom("admin_terms_versions")
          .selectAll()
          .where("id", "=", id)
          .where("status", "=", status)
          .executeTakeFirstOrThrow();
      } else {
        updated = await update.returningAll().executeTakeFirstOrThrow();
      }
      for (const retired of automaticallyRetired) {
        await this.writeOperationAudit(
          transaction,
          adminId,
          "admin.terms.retired",
          "terms_version",
          retired.id,
          { status: "published" },
          { status: "retired", superseded_by: id },
          reason,
          requestId,
        );
      }
      await this.writeOperationAudit(
        transaction,
        adminId,
        status === "published" ? "admin.terms.published" : "admin.terms.retired",
        "terms_version",
        id,
        { status: current.status },
        {
          effective_at: updated.effective_at?.toISOString() ?? null,
          status,
        },
        reason,
        requestId,
      );
      return { version: termsVersionView(updated) };
    });
  }

  async listTermsVersions() {
    return {
      versions: (
        await this.db
          .selectFrom("admin_terms_versions")
          .selectAll()
          .orderBy("created_at", "desc")
          .execute()
      ).map(termsVersionView),
    };
  }

  async listTermsConsents(query: { consent_type: "terms" | "privacy"; policy_version: string }) {
    const policyVersion = query.policy_version.normalize("NFC").trim();
    if ([...policyVersion].length < 1 || [...policyVersion].length > 80) {
      throw adminError(BadRequestException, "ADMIN_TERMS_CONSENT_FILTER_REQUIRED");
    }
    const q = this.db
      .selectFrom("user_consents as c")
      .select([
        "c.id",
        "c.user_id",
        "c.consent_type",
        "c.policy_version",
        "c.accepted_at",
        "c.withdrawn_at",
        "c.retention_expires_at",
      ])
      .where("c.consent_type", "=", query.consent_type)
      .where("c.policy_version", "=", policyVersion)
      .orderBy("c.accepted_at", "desc")
      .limit(500);
    return { consents: await q.execute() };
  }

  async listInquiries(status?: string) {
    let q = this.db
      .selectFrom("admin_inquiries")
      .selectAll()
      .orderBy("updated_at", "desc")
      .limit(100);
    if (status) q = q.where("status", "=", status);
    return { inquiries: await q.execute() };
  }

  async updateInquiry(
    id: string,
    input: {
      status: string;
      internal_note?: string;
      assigned_admin_account_id?: string | null;
      response?: string;
    },
    adminId: string,
    requestId: string,
  ) {
    return this.db.transaction().execute(async (transaction) => {
      const current = await transaction
        .selectFrom("admin_inquiries")
        .select(["id", "status", "assigned_admin_account_id", "internal_note", "response"])
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (current === undefined) throw adminError(NotFoundException, "INQUIRY_NOT_FOUND");
      const update = transaction
        .updateTable("admin_inquiries")
        .set({
          status: input.status,
          ...(input.internal_note === undefined ? {} : { internal_note: input.internal_note }),
          ...(input.assigned_admin_account_id === undefined
            ? {}
            : { assigned_admin_account_id: input.assigned_admin_account_id }),
          ...(input.response === undefined
            ? {}
            : {
                response: input.response,
                responded_at: adminAuthDate(new Date(), this.engine),
                responded_by_admin_account_id: adminId,
              }),
          resolved_at: adminAuthDate(
            input.status === "resolved" || input.status === "closed" ? new Date() : null,
            this.engine,
          ),
          updated_at: adminAuthDate(new Date(), this.engine),
        })
        .where("id", "=", id);
      let row: Selectable<DB["admin_inquiries"]>;
      if (this.engine === "mariadb") {
        await update.executeTakeFirstOrThrow();
        // An identical save can affect zero rows; the locked identity remains authoritative.
        row = await transaction
          .selectFrom("admin_inquiries")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirstOrThrow();
      } else {
        row = await update.returningAll().executeTakeFirstOrThrow();
      }
      await this.writeOperationAudit(
        transaction,
        adminId,
        "admin.inquiry.updated",
        "inquiry",
        id,
        {
          assigned_admin_account_id: current.assigned_admin_account_id,
          responded: current.response !== null,
          status: current.status,
        },
        {
          assigned_admin_account_id: row.assigned_admin_account_id,
          responded: row.response !== null,
          status: row.status,
        },
        null,
        requestId,
      );
      return { inquiry: row, changed_by_admin_id: adminId };
    });
  }

  async getSystemState() {
    return {
      states: await this.db.selectFrom("admin_system_state").selectAll().orderBy("key").execute(),
    };
  }

  async updateSystemState(
    key: "maintenance_mode" | "announcement" | "request_limits",
    value: unknown,
    adminId: string,
    requestId: string,
  ) {
    this.assertSystemStateValue(key, value);
    const result = await this.db.transaction().execute(async (transaction) => {
      if (this.engine === "mariadb") await lockAdminManagementMutation(transaction);
      const previousQuery = transaction
        .selectFrom("admin_system_state")
        .select("value_json")
        .where("key", "=", key);
      const previous = await (
        this.engine === "mariadb" ? previousQuery.forUpdate() : previousQuery
      ).executeTakeFirst();
      const insert = transaction.insertInto("admin_system_state").values({
        key,
        value_json: adminAuthJson(value, this.engine),
        updated_by_admin_account_id: adminId,
        updated_at: adminAuthDate(new Date(), this.engine),
      });
      const updatedValues = {
        value_json: adminAuthJson(value, this.engine),
        updated_by_admin_account_id: adminId,
        updated_at: adminAuthDate(new Date(), this.engine),
      };
      let row: Selectable<DB["admin_system_state"]>;
      if (this.engine === "mariadb") {
        await insert.onDuplicateKeyUpdate(updatedValues).executeTakeFirstOrThrow();
        row = await transaction
          .selectFrom("admin_system_state")
          .selectAll()
          .where("key", "=", key)
          .executeTakeFirstOrThrow();
      } else {
        row = await insert
          .onConflict((oc) =>
            oc.column("key").doUpdateSet({
              ...updatedValues,
            }),
          )
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      await this.writeOperationAudit(
        transaction,
        adminId,
        "admin.system_state.updated",
        "system_state",
        key,
        previous?.value_json ?? null,
        value,
        null,
        requestId,
      );
      return { state: row };
    });
    if (key === "request_limits") invalidateRequestLimitPolicy();
    return result;
  }

  private assertSystemStateValue(
    key: "maintenance_mode" | "announcement" | "request_limits",
    value: unknown,
  ): asserts value is JsonValue {
    if (key === "request_limits") {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw adminError(BadRequestException, "ADMIN_SYSTEM_STATE_INVALID");
      try {
        parseRequestLimitPolicy(value);
      } catch {
        throw new BadRequestException("요청 횟수는 1~20회, 대기 시간은 1~3600초로 입력해 주세요.");
      }
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw adminError(BadRequestException, "ADMIN_SYSTEM_STATE_INVALID");
    }
    const candidate = value as Record<string, unknown>;
    const allowedKeys = key === "announcement" ? ["enabled", "message"] : ["enabled"];
    if (Object.keys(candidate).some((candidateKey) => !allowedKeys.includes(candidateKey))) {
      throw adminError(BadRequestException, "ADMIN_SYSTEM_STATE_INVALID");
    }
    if (typeof candidate.enabled !== "boolean") {
      throw adminError(BadRequestException, "ADMIN_SYSTEM_STATE_INVALID");
    }
    if (
      key === "announcement" &&
      (typeof candidate.message !== "string" ||
        countCodePoints(candidate.message) > 500 ||
        !isAllowedPlainText(candidate.message, true) ||
        (candidate.enabled && candidate.message.trim().length === 0))
    ) {
      throw adminError(BadRequestException, "ADMIN_SYSTEM_STATE_INVALID");
    }
  }

  private async writeOperationAudit(
    transaction: Transaction<DB>,
    actorAdminId: string,
    action: string,
    targetType: string,
    targetId: string,
    before: JsonValue | null,
    after: JsonValue | null,
    reason: string | null,
    requestId: string,
  ) {
    await transaction
      .insertInto("admin_operation_audit_logs")
      .values({
        action,
        actor_admin_account_id: actorAdminId,
        after_json: adminAuthJson(after, this.engine),
        before_json: adminAuthJson(before, this.engine),
        reason,
        request_id: requestId,
        target_id: targetId,
        target_type: targetType,
      })
      .execute();
  }
}
