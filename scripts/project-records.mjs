import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  openRecords,
  putRecord,
  readRecordBytes,
  repositoryRoot,
} from "../OPERATIONS/project-records/store.mjs";

const [command, ...args] = process.argv.slice(2);
if (command === "read") {
  assert.equal(args.length, 1);
  process.stdout.write(readRecordBytes(args[0]));
} else if (command === "list" || command === "search") {
  const database = openRecords();
  try {
    const rows =
      command === "list"
        ? database
            .prepare("SELECT id,title,category,status,bytes FROM documents ORDER BY category,id")
            .all()
        : database
            .prepare(
              "SELECT id,title,category,status FROM documents WHERE id LIKE ? OR title LIKE ? OR CAST(content AS TEXT) LIKE ? ORDER BY id LIMIT 50",
            )
            .all(...Array(3).fill("%" + args.join(" ") + "%"));
    console.log(JSON.stringify(rows, null, 2));
  } finally {
    database.close();
  }
} else if (command === "put") {
  assert.equal(args.length, 1, "Usage: project-records put <record-id> < input-file");
  const database = openRecords({ readOnly: false });
  try {
    const previous = database
      .prepare("SELECT category,status FROM documents WHERE id=?")
      .get(args[0]);
    putRecord(database, args[0], readFileSync(0), previous ?? {});
    console.log(JSON.stringify({ updated: args[0] }));
  } finally {
    database.close();
  }
} else if (command === "export-legal") {
  const paths = {
    terms: "LEGAL/이용약관_개발정본_2026-09-02.md",
    privacy_consent: "LEGAL/개인정보_수집이용_동의서_개발정본_2026-09-02.md",
    privacy_policy: "LEGAL/개인정보처리방침_개발정본_2026-09-02.md",
    guardian_consent: "LEGAL/만14세미만_보호자_고지동의서_개발정본_2026-09-02.md",
  };
  const documents = Object.fromEntries(
    Object.entries(paths).map(([key, id]) => [key, readRecordBytes(id).toString("utf8")]),
  );
  writeFileSync(
    resolve(
      repositoryRoot,
      "apps/web/src/features/legal/development-legal-documents.generated.json",
    ),
    JSON.stringify(documents, null, 2) + "\n",
  );
  console.log(JSON.stringify({ exportedLegalDocuments: Object.keys(documents).length }));
} else {
  throw new Error("Use read <id>, list, search <text>, put <id> (stdin), or export-legal");
}
