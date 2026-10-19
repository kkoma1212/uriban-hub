import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const yamlPath = resolve(ROOT, "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml");
assert(
  JSON.parse(readFileSync(resolve(yamlPath, "package.json"))).version === "2.9.0",
  "Pinned build-only YAML parser is required",
);
const yaml = createRequire(import.meta.url)(yamlPath);
const git = (root, ...args) =>
  execFileSync("git", args, { cwd: root, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });

export function readFrozenLock(text) {
  const parsed = yaml.parse(text, { uniqueKeys: true, maxAliasCount: 0 });
  assert(
    parsed?.lockfileVersion === "9.0" && parsed.packages && parsed.snapshots,
    "Frozen pnpm v9 lock is required",
  );
  const packages = new Map(
    Object.entries(parsed.packages).map(([key, value]) => [
      key,
      { integrity: value.resolution?.integrity },
    ]),
  );
  const snapshots = new Map(
    Object.entries(parsed.snapshots).map(([key, value]) => [
      key,
      { dependencies: { ...value.dependencies, ...value.optionalDependencies } },
    ]),
  );
  for (const snapshot of snapshots.values())
    for (const [name, reference] of Object.entries(snapshot.dependencies))
      assert(
        typeof name === "string" && typeof reference === "string",
        "Invalid locked dependency reference",
      );
  assert(packages.size && snapshots.size, "Frozen lock package/snapshot sections are required");
  return { packages, snapshots };
}

export function verifyRegistryArchive(bytes, integrity) {
  assert(/^sha512-[A-Za-z0-9+/=]+$/u.test(integrity), "Missing lock SHA-512 integrity");
  assert(
    createHash("sha512").update(bytes).digest("base64") === integrity.slice(7),
    "Registry tarball integrity mismatch",
  );
}

function octal(bytes, label) {
  const text = bytes.toString("ascii").replace(/\0.*$/su, "").trim();
  assert(/^[0-7]+$/u.test(text), `Invalid tar ${label}`);
  const value = Number.parseInt(text, 8);
  assert(Number.isSafeInteger(value), `Invalid tar ${label}`);
  return value;
}

/** Validate every member before any extraction. Links and extended headers are forbidden. */
export function inspectPackageTar(tar) {
  assert(tar.length <= 64 * 1024 * 1024 && tar.length % 512 === 0, "Invalid tar size");
  const files = [],
    names = new Set();
  let offset = 0,
    ended = false;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      ended = true;
      assert(
        tar.subarray(offset).every((byte) => byte === 0),
        "Tar trailing data",
      );
      break;
    }
    const sum = header.reduce(
      (total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    assert(sum === octal(header.subarray(148, 156), "checksum"), "Tar checksum mismatch");
    const field = (start, end) =>
      header.subarray(start, end).toString("utf8").replace(/\0.*$/su, "");
    const prefix = field(345, 500),
      name = (prefix ? prefix + "/" : "") + field(0, 100);
    assert(
      name.startsWith("package/") &&
        // eslint-disable-next-line no-control-regex -- reject control characters on purpose
        !/[\\\x00-\x1f\x7f:]/u.test(name) &&
        name === name.normalize("NFC"),
      "Unsafe tar member path",
    );
    const parts = name.replace(/\/$/u, "").split("/");
    assert(
      parts.length > 1 &&
        parts.every(
          (part) =>
            part &&
            part !== "." &&
            part !== ".." &&
            !/[. ]$/u.test(part) &&
            !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
        ),
      "Unsafe tar member path",
    );
    assert(
      !parts.some(
        (part) => part === ".env" || /^\.env\.(?:local|production|development|test)$/iu.test(part),
      ),
      "Active environment files are forbidden",
    );
    const key = name.replace(/\/$/u, "").toLowerCase();
    assert(!names.has(key), "Duplicate tar member path");
    names.add(key);
    const type = header[156];
    assert([0, 48, 53].includes(type), "Tar links or extended members are forbidden");
    const size = octal(header.subarray(124, 136), "member size");
    assert(type !== 53 || size === 0, "Tar directory has content");
    const start = offset + 512,
      end = start + size;
    assert(end <= tar.length, "Truncated tar member");
    if (type !== 53)
      files.push({ path: parts.slice(1).join("/"), bytes: Buffer.from(tar.subarray(start, end)) });
    assert(files.length <= 10000, "Too many tar members");
    offset = start + Math.ceil(size / 512) * 512;
  }
  assert(ended && files.some((file) => file.path === "package.json"), "Incomplete package tar");
  for (const file of files)
    for (const other of files)
      assert(
        !other.path.toLowerCase().startsWith(file.path.toLowerCase() + "/"),
        "Tar file/directory collision",
      );
  return files;
}

function exclusiveFile(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { flag: "wx" });
}
function packageIdentity(name, reference) {
  assert(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(name), "Unsafe dependency name");
  const version = reference.split("(")[0];
  assert(
    /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(version),
    "Dependency must use exact registry version",
  );
  return { name, version, snapshot: `${name}@${reference}`, key: `${name}@${version}` };
}

export async function buildCompanyFirstInstallPackage({
  sourceSha,
  output,
  repositoryRoot = ROOT,
  fetchImpl = fetch,
}) {
  assert(/^24\./u.test(process.versions.node), "Node.js 24 is required");
  assert(/^[a-f0-9]{40}$/u.test(sourceSha ?? ""), "Full immutable source SHA is required");
  assert(
    git(repositoryRoot, "rev-parse", `${sourceSha}^{commit}`).toString().trim() === sourceSha,
    "Source SHA must identify the exact commit",
  );
  const out = resolve(output);
  assert(!existsSync(out), "Output already exists; never overwrite or resume");
  const tracked = git(repositoryRoot, "ls-tree", "-r", "--name-only", "-z", sourceSha)
    .toString()
    .split("\0")
    .filter(Boolean);
  const selected = new Set([
    "package.json",
    "packages/db/package.json",
    "packages/db/src/mariadb/runtime-grant-catalog.json",
    "packages/db/src/mariadb/runtime-grant-profile.ts",
    ".node-version",
    "pnpm-lock.yaml",
    "compose.mariadb-driver-qa.yaml",
    "compose.mariadb-semantic-qa.yaml",
    "OPERATIONS/mariadb-dev/bootstrap/010-development-identities.sql",
    "scripts/generate-first-install-sql.mjs",
    "OPERATIONS/scripts/verify-company-first-install.mjs",
    "OPERATIONS/mariadb-dev/verify-native-installed-schema.mjs",
  ]);
  for (const path of tracked)
    if (/^db\/mariadb\/.*\.(?:mjs|sql|json)$/u.test(path) && !/\.(?:test|spec)\.mjs$/u.test(path))
      selected.add(path);
  const blobs = new Map();
  for (const path of selected) {
    assert(tracked.includes(path), "Source commit lacks required packaging file: " + path);
    const mode = git(repositoryRoot, "ls-tree", sourceSha, "--", path).toString().split(" ")[0];
    assert(mode === "100644" || mode === "100755", "Source member must be a regular Git blob");
    blobs.set(path, git(repositoryRoot, "show", `${sourceSha}:${path}`));
  }
  for (const [path, bytes] of blobs)
    if (path.endsWith(".mjs")) {
      for (const match of bytes
        .toString()
        .matchAll(/(?:from\s*|import\s*\(|new URL\s*\()?["'](\.\.?\/[^"']+\.(?:mjs|json))["']/gu)) {
        const dependency = resolve(repositoryRoot, dirname(path), match[1])
          .slice(resolve(repositoryRoot).length + 1)
          .replaceAll("\\", "/");
        assert(
          tracked.includes(dependency) && !dependency.startsWith(".."),
          "Untracked source dependency: " + path + " -> " + dependency,
        );
        if (!blobs.has(dependency)) {
          assert(/^(?:scripts|OPERATIONS|db)\//u.test(dependency), "Unexpected source dependency");
          assert(
            /^100(?:644|755) /u.test(
              git(repositoryRoot, "ls-tree", sourceSha, "--", dependency).toString(),
            ),
            "Dependency must be a regular Git blob",
          );
          blobs.set(dependency, git(repositoryRoot, "show", `${sourceSha}:${dependency}`));
        }
      }
    }
  const lock = readFrozenLock(blobs.get("pnpm-lock.yaml").toString());
  const dbPackage = JSON.parse(blobs.get("packages/db/package.json"));
  assert(dbPackage.dependencies.mysql2 === "3.24.3", "Reviewed mysql2 version changed");
  const rootRef = [...lock.snapshots.keys()].filter(
    (key) => key.startsWith("mysql2@3.24.3(") || key === "mysql2@3.24.3",
  );
  assert(rootRef.length === 1, "mysql2 snapshot must be unambiguous");
  const dependencies = [],
    archiveCache = new Map();
  async function collect(name, reference, location, ancestors = new Set()) {
    const id = packageIdentity(name, reference);
    assert(!ancestors.has(id.snapshot), "Cyclic dependency closure");
    const snapshot = lock.snapshots.get(id.snapshot),
      resolution = lock.packages.get(id.key);
    assert(
      snapshot && resolution?.integrity,
      "Dependency missing exact locked snapshot or integrity",
    );
    let archive = archiveCache.get(id.key);
    if (!archive) {
      const basename = name.split("/").at(-1),
        url = `https://registry.npmjs.org/${name}/-/${basename}-${id.version}.tgz`;
      const response = await fetchImpl(url, {
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
      assert(response.ok, "Registry dependency download failed");
      const reader = response.body.getReader(),
        chunks = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          assert(size <= 16 * 1024 * 1024, "Registry archive too large");
          chunks.push(Buffer.from(part.value));
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const bytes = Buffer.concat(chunks);
      verifyRegistryArchive(bytes, resolution.integrity);
      const files = inspectPackageTar(gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }));
      const manifest = JSON.parse(files.find((file) => file.path === "package.json").bytes);
      assert(
        manifest.name === name && manifest.version === id.version,
        "Registry package identity mismatch",
      );
      assert(
        files.some((file) => /(?:^|\/)(?:license|licence|copying)(?:\.[^/]*)?$/iu.test(file.path)),
        "Dependency license is missing",
      );
      const runtimeDependencies = Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
      });
      for (const key of runtimeDependencies)
        assert(
          Object.hasOwn(snapshot.dependencies, key),
          "Runtime dependency is absent from lock snapshot",
        );
      archive = { files, runtimeDependencies };
      archiveCache.set(id.key, archive);
      dependencies.push({
        name,
        version: id.version,
        integrity: resolution.integrity,
        archive_sha256: digest(bytes),
        snapshot: id.snapshot,
      });
    }
    for (const file of archive.files) exclusiveFile(resolve(out, location, file.path), file.bytes);
    const chain = new Set([...ancestors, id.snapshot]);
    for (const child of archive.runtimeDependencies)
      await collect(
        child,
        snapshot.dependencies[child],
        `${location}/node_modules/${child}`,
        chain,
      );
  }
  // Output is new and remains visibly partial after failure; never erase or auto-resume.
  mkdirSync(out);
  for (const [path, bytes] of blobs) exclusiveFile(resolve(out, "runtime", path), bytes);
  await collect(
    "mysql2",
    rootRef[0].slice("mysql2@".length),
    "runtime/packages/db/node_modules/mysql2",
  );
  const generated = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import{buildFirstInstallSql}from'./scripts/generate-first-install-sql.mjs';const r=buildFirstInstallSql();process.stdout.write(JSON.stringify(r))",
    ],
    { cwd: resolve(out, "runtime"), windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  const result = JSON.parse(generated);
  assert(
    result.manifest.ledger_rows === 95 &&
      digest(Buffer.from(result.sql)) === result.manifest.sql_sha256,
    "Generated installation SQL mismatch",
  );
  exclusiveFile(resolve(out, "01-schema-install.sql"), result.sql);
  exclusiveFile(
    resolve(out, "01-schema-install.sql.manifest.json"),
    JSON.stringify(result.manifest),
  );
  exclusiveFile(
    resolve(out, "README.txt"),
    "우리반 허브 회사 신규 설치 95개 원장 전용\nNode.js 24.x is required separately. No runtime or server is installed by this package. All runtime/ SQL files, QA compose files and development-identities are historical catalog provenance only: never execute or deploy them. Only the top-level 01-schema-install.sql is the manual fresh-install artifact.\nDBA manual installation only: empty MariaDB 11.4.13 server (the exact reviewed version), five securely pre-provisioned USAGE-only REQUIRE SSL accounts at %, no other hosts/roles/proxies/PUBLIC grants, exclusive access. TLS configuration and credentials are the server owner's responsibility.\nCheck SQL/manifest/package file hashes before manual application. Use the MariaDB client without --force; stop on any error. Never retry, resume, repair or apply to an existing/partial/legacy 93-row database. Review those targets separately.\nAfter installation, run the read-only verifier from runtime: node OPERATIONS/scripts/verify-company-first-install.mjs (no arguments). COMPANY_INSTALLATION_DATABASE_URL and COMPANY_INSTALLATION_CA_FILE are supplied by the server owner; never put their values in this package. No company credentials or active .env are included; historical QA sources contain synthetic examples that must not be used. Verification is not release admission and does not prove company deployment.\n",
  );
  const inventory = [];
  function walk(directory, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name),
        name = prefix + entry.name;
      if (entry.isDirectory()) walk(path, name + "/");
      else inventory.push({ path: name, sha256: digest(readFileSync(path)) });
    }
  }
  walk(out);
  inventory.sort((a, b) => a.path.localeCompare(b.path, "en"));
  exclusiveFile(
    resolve(out, "package-evidence.json"),
    JSON.stringify({
      schema_version: 1,
      source_sha: sourceSha,
      admission: false,
      node_required: "24.x",
      source_files: [...blobs].map(([path, bytes]) => ({ path, sha256: digest(bytes) })),
      dependencies,
      files: inventory,
      sql_sha256: result.manifest.sql_sha256,
    }),
  );
  return { output: out, sourceSha, ledgerRows: 95, admission: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  assert(
    args.length === 4 && args[0] === "--source-sha" && args[2] === "--output",
    "Usage: node scripts/build-company-first-install-package.mjs --source-sha <40hex> --output <new-directory>",
  );
  console.log(
    JSON.stringify(await buildCompanyFirstInstallPackage({ sourceSha: args[1], output: args[3] })),
  );
}
