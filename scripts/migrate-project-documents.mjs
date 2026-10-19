import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  digest,
  openRecords,
  putRecord,
  repositoryRoot,
} from "../OPERATIONS/project-records/store.mjs";

const keep = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md", "THIRD_PARTY_NOTICES.md"]);
const obsolete = new Map([
  [".agents/MEMORY.md", "Navigation index replaced by database search and AGENTS entry point"],
  ["hexstack/memory/MEMORY.md", "Duplicate navigation index replaced by database search"],
  [
    "hexstack/collab/COLLAB_TEMPLATE.md",
    "Unused blank collaboration template; current mode is solo",
  ],
  [
    "hexstack/collab/REQUEST_TEMPLATE.md",
    "Unused blank collaboration template; current mode is solo",
  ],
  [
    "hexstack/collab/REPLY_TEMPLATE.md",
    "Unused blank collaboration template; current mode is solo",
  ],
]);
const categoryFor = (path) =>
  path.startsWith("PRD/")
    ? "product"
    : path.startsWith("LEGAL/")
      ? "legal"
      : path.includes("memory/")
        ? "memory"
        : path.startsWith("hexstack/")
          ? "policy"
          : path.startsWith("QUALITY/") || path.includes("-qa") || path.includes("/verification/")
            ? "verification"
            : "operations";
const directory = resolve(repositoryRoot, ".local-runtime/web-documents-20260911");
if (process.argv[2] === "--verify") {
  const plan = JSON.parse(readFileSync(resolve(directory, "document-plan.json"), "utf8"));
  const database = openRecords();
  let verified = 0;
  try {
    for (const entry of plan.decisions.filter((row) => row.action === "database")) {
      const row = database
        .prepare("SELECT content,sha256 FROM documents WHERE id=?")
        .get(entry.path);
      assert.ok(row, "Missing document: " + entry.path);
      assert.equal(digest(Buffer.from(row.content)), entry.sha256);
      assert.equal(row.sha256, entry.sha256);
      verified++;
    }
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally {
    database.close();
  }
  const result = { at: new Date().toISOString(), verified, roundTripVerified: true };
  writeFileSync(
    resolve(directory, "database-verified.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
  process.exit(0);
}
const paths = execFileSync("git", ["ls-files", "-z", "--", "*.md", "*.MD"], { cwd: repositoryRoot })
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .filter((path) => existsSync(resolve(repositoryRoot, path)));
const decisions = paths.map((path) => {
  const absolute = resolve(repositoryRoot, path);
  assert.ok(absolute.startsWith(resolve(repositoryRoot) + sep));
  assert.equal(lstatSync(absolute).isSymbolicLink(), false);
  const bytes = readFileSync(absolute);
  const action = keep.has(path)
    ? "keep-entry-or-license"
    : obsolete.has(path)
      ? "remove-obsolete"
      : "database";
  return {
    path,
    action,
    reason:
      obsolete.get(path) ??
      (keep.has(path)
        ? "Tool entry point or generated dependency license notice"
        : "Preserve unique product, policy, operating or verification information in searchable database"),
    sha256: digest(bytes),
    bytes: bytes.length,
    category: categoryFor(path),
  };
});
mkdirSync(directory, { recursive: true });
writeFileSync(
  resolve(directory, "document-plan.json"),
  JSON.stringify({ at: new Date().toISOString(), decisions }, null, 2) + "\n",
);
if (process.argv[2] === "--import") {
  const database = openRecords({ readOnly: false });
  try {
    database.exec("BEGIN IMMEDIATE");
    for (const entry of decisions) {
      database
        .prepare(
          "INSERT OR REPLACE INTO migration_decisions(path,action,reason,sha256) VALUES(?,?,?,?)",
        )
        .run(entry.path, entry.action, entry.reason, entry.sha256);
      if (entry.action !== "database") continue;
      const bytes = readFileSync(resolve(repositoryRoot, entry.path));
      assert.equal(digest(bytes), entry.sha256);
      putRecord(database, entry.path, bytes, {
        category: entry.category,
        status: entry.category === "verification" ? "evidence" : "active",
      });
      const saved = database
        .prepare("SELECT content,sha256 FROM documents WHERE id=?")
        .get(entry.path);
      assert.ok(Buffer.from(saved.content).equals(bytes));
      assert.equal(saved.sha256, entry.sha256);
    }
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}
console.log(
  JSON.stringify({
    documents: decisions.length,
    bytes: decisions.reduce((sum, row) => sum + row.bytes, 0),
    counts: Object.fromEntries(
      [...new Set(decisions.map((row) => row.action))].map((action) => [
        action,
        decisions.filter((row) => row.action === action).length,
      ]),
    ),
    imported: process.argv[2] === "--import",
  }),
);
