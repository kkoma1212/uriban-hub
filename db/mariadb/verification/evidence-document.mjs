import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRecordBytes, repositoryRoot } from "../../../OPERATIONS/project-records/store.mjs";

/*
 * 2026-09-11 문서 DB 전환: 검증 시험이 읽던 Markdown 증거 문서(*_gaps.md·PRD)는 저장소 파일 대신
 * data/project-records.sqlite에 같은 경로 이름(기록 ID)으로 들어 있다. 파일이 있으면 파일을, 없으면 문서 DB를 읽는다.
 * id는 저장소 기준 경로(예: "db/mariadb/verification/0004_audit_import_logs_gaps.md").
 */
export function readEvidenceDocument(id) {
  const path = resolve(repositoryRoot, id);
  return existsSync(path) ? readFileSync(path, "utf8") : readRecordBytes(id).toString("utf8");
}

/** 증거 문서가 파일이나 문서 DB 어느 한쪽에 있는지. */
export function evidenceDocumentExists(id) {
  if (existsSync(resolve(repositoryRoot, id))) return true;
  try {
    readRecordBytes(id);
    return true;
  } catch {
    return false;
  }
}
