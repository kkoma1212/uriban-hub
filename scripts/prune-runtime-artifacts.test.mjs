import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const scriptPath = fileURLToPath(new URL("./prune-runtime-artifacts.mjs", import.meta.url));

async function fixture(context, files) {
  const parent = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(parent, "classhub-runtime-artifacts-"));
  context.after(async () => {
    // Delete only this test's own absolute mkdtemp directory, never a caller-supplied artifact root.
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith("classhub-runtime-artifacts-"));
    await rm(root, { recursive: true, force: true });
  });
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    assert.ok(!path.relative(root, target).startsWith(".."));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  return root;
}

function run(...roots) {
  return spawnSync(process.execPath, [scriptPath, ...roots], { encoding: "utf8" });
}

test("retains and imports entry -> OpenAPI contract -> runtime dependency while removing the standalone generator", async (context) => {
  const files = {
    "package.json": '{"type":"module"}\n',
    "app.factory.js":
      'import { contract } from "./openapi/contract.js"; export const ready = contract();\n',
    "openapi/contract.js":
      'import { cookie } from "../auth/session-cookie.js"; export const contract = () => cookie;\n',
    "auth/session-cookie.js": 'export const cookie = "synthetic-session";\n',
    "openapi/generate.js": 'throw new Error("standalone generator must not run");\n',
    "openapi/generate.js.map": "{}",
    "openapi/contract.js.map": "{}",
    "openapi/contract.d.ts": "export declare const contract: unknown;",
    "local-test-admin/controller.js": 'throw new Error("local admin must not ship");',
    "local-test-admin/src/private.ts": "synthetic source",
    "other/generate.js": "export const runtimeGenerator = true;",
  };
  const root = await fixture(context, files);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /validated runtime artifact root/u);
  assert.equal(
    await readFile(path.join(root, "openapi/contract.js"), "utf8"),
    files["openapi/contract.js"],
  );
  assert.deepEqual(await readdir(path.join(root, "openapi")), ["contract.js"]);
  await assert.rejects(access(path.join(root, "local-test-admin")), { code: "ENOENT" });
  assert.equal(
    await readFile(path.join(root, "other/generate.js"), "utf8"),
    files["other/generate.js"],
  );

  const imported = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'const app = await import(process.argv[1]); if (app.ready !== "synthetic-session") process.exit(1);',
      pathToFileURL(path.join(root, "app.factory.js")).href,
    ],
    { encoding: "utf8" },
  );
  assert.equal(imported.status, 0, imported.stderr);
});

test("rejects a missing root argument", () => {
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /at least one runtime artifact root is required/u);
});

for (const directory of ["__tests__", "src", "test", "tests"]) {
  test(`continues rejecting the forbidden ${directory} directory`, async (context) => {
    const root = await fixture(context, { [`${directory}/index.js`]: "export {};" });
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime artifact contains forbidden directory/u);
    await access(path.join(root, directory, "index.js"));
  });
}

for (const name of ["service.spec.js", "service.test.js", "openapi/contract.spec.js"]) {
  test(`continues rejecting compiled tests: ${name}`, async (context) => {
    const root = await fixture(context, { [name]: "export {};" });
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime artifact contains a compiled test/u);
    await access(path.join(root, name));
  });
}

test("continues rejecting an unexpected artifact type", async (context) => {
  const root = await fixture(context, { "contract.ts": "export {};" });
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runtime artifact contains an unexpected file type/u);
});

test("continues rejecting a root made empty by pruning", async (context) => {
  const root = await fixture(context, { "index.d.ts": "export {};", "index.js.map": "{}" });
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runtime artifact root is empty after pruning/u);
});
