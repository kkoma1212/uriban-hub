import { createHash } from "node:crypto";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Selectable } from "kysely";
import type { DB } from "@classhub/db";

import { ADMIN_LEGAL_DOCUMENT_TYPES } from "../admin-management/admin-management.dto.js";
import {
  createMariaDbRowCodec,
  mariaDbDateBinding,
  mariaDbDateTime,
  mariaDbNullable,
} from "../common/database/mariadb-values.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { countCodePoints, isAllowedPlainText } from "../common/validation/text-validation.js";
import { currentLegalConsentSnapshot } from "./legal-consent-snapshot.js";

const publicFields = [
  "id",
  "document_type",
  "policy_version",
  "title",
  "content",
  "content_sha256",
  "effective_at",
  "published_at",
  "status",
] as const;
type PublicRow = Pick<Selectable<DB["admin_terms_versions"]>, (typeof publicFields)[number]>;
const codec = createMariaDbRowCodec({
  effective_at: mariaDbNullable(mariaDbDateTime),
  published_at: mariaDbNullable(mariaDbDateTime),
});

function publishedVersion(row: PublicRow, now: Date) {
  if (
    (row.status !== "published" && row.status !== "retired") ||
    row.effective_at === null ||
    row.published_at === null ||
    row.effective_at.getTime() > now.getTime() ||
    row.published_at.getTime() > now.getTime() ||
    /\[게시본 주입|\[게시 전 확정|개발 정본/u.test(row.content + row.title)
  )
    return null;
  const digest = createHash("sha256").update(row.content, "utf8").digest();
  if (!Buffer.isBuffer(row.content_sha256) || !digest.equals(row.content_sha256)) return null;
  // Explicit projection keeps the author's administrator identity private.
  return {
    id: row.id,
    document_type: row.document_type,
    policy_version: row.policy_version,
    title: row.title,
    content: row.content,
    content_sha256: digest.toString("hex"),
    effective_at: row.effective_at.toISOString(),
    published_at: row.published_at.toISOString(),
    status: row.status,
  };
}

@Injectable()
export class LegalDocumentsService {
  private readonly database: ClassHubDatabase;
  private readonly mariaDb: boolean;
  private readonly bindingRequired: boolean;
  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    config: ConfigService<AppEnvironment, true>,
  ) {
    this.mariaDb = config.get("DATABASE_ENGINE", { infer: true }) === "mariadb";
    this.bindingRequired =
      config.get("NODE_ENV", { infer: true }) === "production" ||
      config.get("LEGAL_CONSENT_BINDING_ENABLED", { infer: true }) === true;
    this.database = this.mariaDb ? database.withPlugin(codec) : database;
  }

  async consentBundle() {
    return {
      binding_required: this.bindingRequired,
      documents: this.bindingRequired
        ? await currentLegalConsentSnapshot(this.database, this.mariaDb, new Date())
        : null,
    };
  }

  async read(documentType: string, policyVersion?: string) {
    if (
      !ADMIN_LEGAL_DOCUMENT_TYPES.some((type) => type === documentType) ||
      (policyVersion !== undefined &&
        (countCodePoints(policyVersion) < 1 ||
          countCodePoints(policyVersion) > 80 ||
          !isAllowedPlainText(policyVersion)))
    ) {
      throw new BadRequestException("LEGAL_DOCUMENT_QUERY_INVALID");
    }
    const now = new Date();
    const boundNow = this.mariaDb ? mariaDbDateBinding(now) : now;
    const rows = await this.database
      .selectFrom("admin_terms_versions")
      .select(publicFields)
      .where("document_type", "=", documentType)
      .where("status", "in", ["published", "retired"])
      .where("published_at", "<=", boundNow)
      .where("effective_at", "<=", boundNow)
      .orderBy("effective_at", "desc")
      .orderBy("id", "desc")
      .execute();
    const published = rows
      .map((row) => publishedVersion(row, now))
      .filter((version) => version !== null);
    const version =
      published.find((item) =>
        policyVersion === undefined
          ? item.status === "published"
          : item.policy_version === policyVersion,
      ) ?? null;
    return {
      version,
      versions: published.map(({ id, policy_version, title, effective_at, status }) => ({
        id,
        policy_version,
        title,
        effective_at,
        status,
      })),
    };
  }
}
