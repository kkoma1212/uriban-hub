import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { gzipSync } from "node:zlib";
import {
  inspectPackageTar,
  verifyRegistryArchive,
  readFrozenLock,
  buildCompanyFirstInstallPackage,
} from "./build-company-first-install-package.mjs";
const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function tar(entries) {
  const pieces = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? ""),
      h = Buffer.alloc(512);
    h.write(entry.name, 0, 100);
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.fill(32, 148, 156);
    h[156] = entry.type ?? 48;
    h.write("ustar\0", 257);
    h.write("00", 263);
    const sum = h.reduce((a, b) => a + b, 0);
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    pieces.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return Buffer.concat([...pieces, Buffer.alloc(1024)]);
}
const packageTar = (name, version, dependencies = {}) =>
  gzipSync(
    tar([
      {
        name: "package/package.json",
        body: JSON.stringify({ name, version, dependencies, main: "index.js" }),
      },
      { name: "package/LICENSE", body: "MIT synthetic fixture" },
      { name: "package/index.js", body: "module.exports={fixture:true}" },
      { name: "package/promise.js", body: "module.exports={fixture:true}" },
    ]),
  );
test("tar validation rejects hostile paths, links, aliases and conflicts before extraction", () => {
  for (const name of [
    "../escape",
    "/package/x",
    "package/../escape",
    "package/a\\x",
    "other/x",
    "package/a:x",
    "package/a\n",
    "package/CON",
    "package/name.",
    "package/name ",
    "package/.env",
  ]) {
    assert.throws(
      () =>
        inspectPackageTar(
          tar([
            { name, body: "x" },
            { name: "package/package.json", body: "{}" },
          ]),
        ),
      /Unsafe|environment/,
    );
  }
  for (const type of [49, 50, 120, 103])
    assert.throws(
      () => inspectPackageTar(tar([{ name: "package/package.json", body: "{}", type }])),
      /links|extended/,
    );
  for (const names of [
    ["package/X", "package/x"],
    ["package/Foo", "package/foo/bar"],
  ])
    assert.throws(
      () =>
        inspectPackageTar(
          tar([
            ...names.map((name) => ({ name, body: "x" })),
            { name: "package/package.json", body: "{}" },
          ]),
        ),
      /Duplicate|collision/,
    );
  const bytes = tar([{ name: "package/package.json", body: "{}" }]);
  bytes[100] ^= 1;
  assert.throws(() => inspectPackageTar(bytes), /checksum/);
});
test("registry SHA-512 and quoted peer snapshots are exact, duplicates rejected", () => {
  const archive = packageTar("mysql2", "3.24.3"),
    sri = "sha512-" + createHash("sha512").update(archive).digest("base64");
  verifyRegistryArchive(archive, sri);
  assert.throws(
    () => verifyRegistryArchive(Buffer.concat([archive, Buffer.from("x")]), sri),
    /integrity/,
  );
  const text = `lockfileVersion: '9.0'\npackages:\n  'mysql2@3.24.3':\n    resolution: {integrity: ${sri}}\nsnapshots:\n  'mysql2@3.24.3(@types/node@24.13.3)':\n    dependencies:\n      '@types/node': 24.13.3\n`;
  assert.equal(
    readFrozenLock(text).snapshots.get("mysql2@3.24.3(@types/node@24.13.3)").dependencies[
      "@types/node"
    ],
    "24.13.3",
  );
  assert.throws(
    () => readFrozenLock(text + "  'mysql2@3.24.3(@types/node@24.13.3)': {}\n"),
    /unique|duplicat/i,
  );
});
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "company-package-test-"));
  roots.push(root);
  const repo = resolve(root, "repo"),
    out = resolve(root, "package");
  mkdirSync(repo);
  const mysql = packageTar("mysql2", "3.24.3", { dep: "^1.0.0" }),
    dep = packageTar("dep", "1.0.1");
  const sri = (bytes) => "sha512-" + createHash("sha512").update(bytes).digest("base64");
  const files = {
    "packages/db/src/mariadb/runtime-grant-catalog.json": "{}",
    "packages/db/src/mariadb/runtime-grant-profile.ts": "provenance only",
    "compose.mariadb-semantic-qa.yaml": "provenance only",
    "OPERATIONS/mariadb-dev/bootstrap/010-development-identities.sql": "provenance only",
    "compose.mariadb-driver-qa.yaml": "provenance only",
    "package.json": "{}",
    "packages/db/package.json": JSON.stringify({ dependencies: { mysql2: "3.24.3" } }),
    ".node-version": "24.20.0",
    "pnpm-lock.yaml": `lockfileVersion: '9.0'\npackages:\n  mysql2@3.24.3:\n    resolution: {integrity: ${sri(mysql)}}\n  dep@1.0.1:\n    resolution: {integrity: ${sri(dep)}}\nsnapshots:\n  mysql2@3.24.3:\n    dependencies:\n      dep: 1.0.1\n  dep@1.0.1: {}\n`,
    "scripts/generate-first-install-sql.mjs": `export function buildFirstInstallSql(){return {sql:'immutable original SQL',manifest:{ledger_rows:95,sql_sha256:'${hash(Buffer.from("immutable original SQL"))}'}}}`,
    "OPERATIONS/scripts/verify-company-first-install.mjs":
      "import{createRequire}from'node:module';const require=createRequire(new URL('../../packages/db/package.json',import.meta.url));export const driver=require('mysql2/promise');",
    "OPERATIONS/mariadb-dev/verify-native-installed-schema.mjs": "export const unused=true;",
    "db/mariadb/manifest.json": "{}",
    "db/mariadb/secret.test.mjs": "secret excluded",
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(resolve(repo, path)), { recursive: true });
    writeFileSync(resolve(repo, path), body);
  }
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  git("init");
  git("add", ".");
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "synthetic package test",
  );
  const sha = git("rev-parse", "HEAD");
  writeFileSync(
    resolve(repo, "scripts/generate-first-install-sql.mjs"),
    "throw Error('dirty must never execute')",
  );
  writeFileSync(resolve(repo, ".env"), "secret must never copy");
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    return new Response(url.endsWith("mysql2-3.24.3.tgz") ? mysql : dep);
  };
  return { root, repo, out, sha, fetchImpl, requests };
}
test("immutable Git bytes, exact locked runtime closure, licenses and offline import survive dirty worktree", async () => {
  const f = fixture();
  const result = await buildCompanyFirstInstallPackage({
    sourceSha: f.sha,
    output: f.out,
    repositoryRoot: f.repo,
    fetchImpl: f.fetchImpl,
  });
  assert.equal(result.admission, false);
  assert.equal(
    readFileSync(resolve(f.out, "01-schema-install.sql"), "utf8"),
    "immutable original SQL",
  );
  assert(!existsSync(resolve(f.out, "runtime/.env")));
  assert(!existsSync(resolve(f.out, "runtime/db/mariadb/secret.test.mjs")));
  const manifest = readFileSync(resolve(f.out, "01-schema-install.sql.manifest.json"), "utf8");
  assert.equal(manifest, JSON.stringify(JSON.parse(manifest)));
  assert.equal(f.requests.length, 2);
  assert(
    existsSync(resolve(f.out, "runtime/packages/db/node_modules/mysql2/node_modules/dep/LICENSE")),
  );
  const evidence = JSON.parse(readFileSync(resolve(f.out, "package-evidence.json")));
  for (const entry of evidence.files)
    assert.equal(hash(readFileSync(resolve(f.out, entry.path))), entry.sha256);
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import{driver}from'./OPERATIONS/scripts/verify-company-first-install.mjs';if(!driver.fixture)throw Error('offline driver missing')",
    ],
    { cwd: resolve(f.out, "runtime"), windowsHide: true },
  );
  await assert.rejects(
    buildCompanyFirstInstallPackage({
      sourceSha: f.sha,
      output: f.out,
      repositoryRoot: f.repo,
      fetchImpl: f.fetchImpl,
    }),
    /already exists/,
  );
});
test("SRI mismatch leaves a clearly partial output and never retries or overwrites", async () => {
  const f = fixture();
  await assert.rejects(
    buildCompanyFirstInstallPackage({
      sourceSha: f.sha,
      output: f.out,
      repositoryRoot: f.repo,
      fetchImpl: async () => new Response("tampered archive"),
    }),
    /integrity/,
  );
  assert(existsSync(resolve(f.out, "runtime/package.json")));
  assert(!existsSync(resolve(f.out, "01-schema-install.sql")));
  await assert.rejects(
    buildCompanyFirstInstallPackage({
      sourceSha: f.sha,
      output: f.out,
      repositoryRoot: f.repo,
      fetchImpl: f.fetchImpl,
    }),
    /already exists/,
  );
});
