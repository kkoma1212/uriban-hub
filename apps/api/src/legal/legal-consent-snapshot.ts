import { createHash } from "node:crypto";
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { ERROR_CODES } from "../common/errors/error-codes.js";
import type { ClassHubDatabase } from "../database/database.module.js";
import {
  createMariaDbRowCodec,
  mariaDbDateBinding,
  mariaDbDateTime,
  mariaDbNullable,
} from "../common/database/mariadb-values.js";

export const CONSENT_DOCUMENT_TYPES = [
  "terms",
  "privacy_consent",
  "privacy_policy",
  "guardian_consent",
] as const;
export type ConsentDocumentType = (typeof CONSENT_DOCUMENT_TYPES)[number];
export interface ConsentDocumentReference {
  id: string;
  policy_version: string;
  content_sha256: string;
}
export type LegalConsentSnapshot = Record<ConsentDocumentType, ConsentDocumentReference>;

export class LegalDocumentsUnavailableException extends ServiceUnavailableException {
  constructor() {
    super({
      code: ERROR_CODES.LEGAL_DOCUMENTS_UNAVAILABLE,
      message: "가입 안내 문서를 준비 중입니다. 잠시 후 다시 확인해 주세요.",
    });
  }
}
export class LegalDocumentsChangedException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.LEGAL_DOCUMENTS_CHANGED,
      message: "동의 대상 문서가 변경됐습니다. 문서를 다시 확인하고 동의해 주세요.",
    });
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseLegalConsentSnapshot(input: unknown): LegalConsentSnapshot | null {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!object(value) || Object.keys(value).length !== CONSENT_DOCUMENT_TYPES.length) return null;
  const result = {} as LegalConsentSnapshot;
  for (const type of CONSENT_DOCUMENT_TYPES) {
    const entry = value[type];
    if (
      !object(entry) ||
      Object.keys(entry).length !== 3 ||
      typeof entry.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(entry.id) ||
      typeof entry.policy_version !== "string" ||
      [...entry.policy_version].length > 80 ||
      entry.policy_version.trim() !== entry.policy_version ||
      entry.policy_version.length === 0 ||
      typeof entry.content_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(entry.content_sha256)
    )
      return null;
    result[type] = {
      id: entry.id,
      policy_version: entry.policy_version,
      content_sha256: entry.content_sha256,
    };
  }
  return result;
}
export function sameLegalConsentSnapshot(first: unknown, second: unknown): boolean {
  const a = parseLegalConsentSnapshot(first),
    b = parseLegalConsentSnapshot(second);
  return a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b);
}
export function requireLegalConsentSnapshot(
  submitted: unknown,
  current: LegalConsentSnapshot,
): LegalConsentSnapshot {
  if (!sameLegalConsentSnapshot(submitted, current)) throw new LegalDocumentsChangedException();
  return current;
}

const codec = createMariaDbRowCodec({
  effective_at: mariaDbNullable(mariaDbDateTime),
  published_at: mariaDbNullable(mariaDbDateTime),
});

// Writers hold the current published rows until their consent transaction commits.
// Publication retires these same rows, so an in-flight consent cannot silently
// record a newer document than the one the client explicitly confirmed.
export async function currentLegalConsentSnapshot(
  database: ClassHubDatabase,
  mariaDb: boolean,
  now: Date,
  lock = false,
): Promise<LegalConsentSnapshot> {
  const target = mariaDb ? database.withPlugin(codec) : database;
  const boundNow = mariaDb ? mariaDbDateBinding(now) : now;
  let query = target
    .selectFrom("admin_terms_versions")
    .select([
      "id",
      "document_type",
      "policy_version",
      "title",
      "content",
      "content_sha256",
      "effective_at",
      "published_at",
    ])
    .where("document_type", "in", [...CONSENT_DOCUMENT_TYPES])
    .where("status", "=", "published")
    .where("effective_at", "<=", boundNow)
    .where("published_at", "<=", boundNow)
    .orderBy("document_type")
    .orderBy("effective_at", "desc")
    .orderBy("id", "desc");
  if (lock) query = query.forUpdate();
  const rows = await query.execute();
  const snapshot = {} as LegalConsentSnapshot;
  for (const type of CONSENT_DOCUMENT_TYPES) {
    const row = rows.find((item) => item.document_type === type);
    if (
      !row ||
      row.effective_at === null ||
      row.published_at === null ||
      row.effective_at.getTime() > now.getTime() ||
      row.published_at.getTime() > now.getTime() ||
      /\[게시본 주입|\[게시 전 확정|개발 정본/u.test(row.content + row.title)
    )
      throw new LegalDocumentsUnavailableException();
    const hash = createHash("sha256").update(row.content, "utf8").digest();
    if (!Buffer.isBuffer(row.content_sha256) || !hash.equals(row.content_sha256))
      throw new LegalDocumentsUnavailableException();
    snapshot[type] = {
      id: row.id,
      policy_version: row.policy_version,
      content_sha256: hash.toString("hex"),
    };
  }
  if (parseLegalConsentSnapshot(snapshot) === null) throw new LegalDocumentsUnavailableException();
  return snapshot;
}
