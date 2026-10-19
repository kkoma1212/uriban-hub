import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "Web");
const runtime = resolve(root, ".local-runtime/web-deployment");
const qaOutput = resolve(root, ".local-runtime/qa-web");
const qaProductionOutput = resolve(root, ".local-runtime/qa-web-production");
const qaAdminOutput = resolve(root, ".local-runtime/qa-admin-web");
const changesPath = resolve(root, "OPERATIONS/web-deployment/changes.json");
const manifestPath = resolve(runtime, "manifest.json");
const deployedPath = resolve(runtime, "deployed.json");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function contained(base, path) {
  const absolute = resolve(path);
  assert.ok(absolute.startsWith(resolve(base) + sep), "Deployment path escaped its directory");
  for (let parent = absolute; parent.length >= resolve(base).length; parent = dirname(parent)) {
    if (existsSync(parent))
      assert.equal(lstatSync(parent).isSymbolicLink(), false, "Deployment path traverses a link");
  }
  return absolute;
}
function inventory(directory) {
  const files = {};
  function visit(current, prefix = "") {
    if (!existsSync(current)) return;
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const path = contained(directory, resolve(current, item.name));
      assert.equal(item.isSymbolicLink(), false);
      if (item.isDirectory()) visit(path, prefix + item.name + "/");
      else {
        assert.equal(item.isFile(), true);
        const bytes = readFileSync(path);
        files[prefix + item.name] = { sha256: sha256(bytes), bytes: bytes.length };
      }
    }
  }
  visit(directory);
  return files;
}
function copyVerified(from, to, files) {
  for (const name of Object.keys(files).sort(
    (a, b) => Number(a === "index.html") - Number(b === "index.html") || a.localeCompare(b),
  )) {
    const source = contained(from, resolve(from, name)),
      destination = contained(to, resolve(to, name));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    assert.equal(sha256(readFileSync(destination)), files[name].sha256, "Deployment copy mismatch");
  }
}
function loadJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}
function updateChanges(files, build = {}) {
  assert.ok(files["index.html"], "No complete Web build to inspect");
  const deployed = loadJson(deployedPath);
  const baseline = deployed?.files ?? {};
  const added = Object.keys(files).filter((name) => !baseline[name]);
  const modified = Object.keys(files).filter(
    (name) => baseline[name] && baseline[name].sha256 !== files[name].sha256,
  );
  const removed = Object.keys(baseline).filter((name) => !files[name]);
  const totalChanges = added.length + modified.length + removed.length;
  const report = {
    at: new Date().toISOString(),
    directory: "Web",
    mode: build.mode ?? loadJson(manifestPath)?.mode ?? loadJson(changesPath)?.mode ?? null,
    fileCount: Object.keys(files).length,
    totalBytes: Object.values(files).reduce((sum, file) => sum + file.bytes, 0),
    added: added.map((name) => "Web/" + name),
    modified: modified.map((name) => "Web/" + name),
    removed: removed.map((name) => "Web/" + name),
    deploymentBaselineAt: deployed?.at ?? null,
    buildChanges: build.changes ?? loadJson(changesPath)?.buildChanges ?? null,
    recommendation:
      !deployed || totalChanges > 10
        ? "deploy-all-Web"
        : totalChanges === 0
          ? "no-changes"
          : "review-listed-changes",
    cloudflarePagesUpload:
      "Upload the complete Web directory for each deployment; partial folders are incomplete deployments.",
  };
  mkdirSync(dirname(changesPath), { recursive: true });
  writeFileSync(changesPath, JSON.stringify(report, null, 2) + "\n");
  return report;
}
// target: "user" = 학생·교사 화면(Web/), "admin" = 관리자 화면(AdminWeb/) — T-ADMIN-SPLIT 2026-10-07.
function buildVerifiedStage(mode, stage, target = "user") {
  execFileSync(process.execPath, [resolve(root, "scripts/project-records.mjs"), "export-legal"], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  execFileSync(
    process.execPath,
    [
      resolve(root, "node_modules/typescript/bin/tsc"),
      "-p",
      resolve(root, "apps/web/tsconfig.json"),
      "--noEmit",
    ],
    { cwd: root, stdio: "inherit", windowsHide: true },
  );
  execFileSync(
    process.execPath,
    [
      resolve(root, "apps/web/node_modules/vite/bin/vite.js"),
      "build",
      resolve(root, "apps/web"),
      "--mode",
      mode,
      "--outDir",
      stage,
      "--logLevel",
      "warn",
    ],
    {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, CLASSHUB_WEB_TARGET: target },
    },
  );
  execFileSync(
    process.execPath,
    [resolve(root, "apps/web/scripts/check-build-output.mjs"), stage, mode, target],
    { cwd: root, stdio: "inherit", windowsHide: true },
  );
  const files = inventory(stage);
  assert.ok(files[target === "admin" ? "admin/index.html" : "index.html"]);
  for (const name of Object.keys(files))
    assert.ok(
      !/(?:^|\/)(?:node_modules|\.env|data)(?:\/|$)|\.(?:md|map|sqlite|db|sql|ini|ts|tsx)$/iu.test(
        name,
      ),
      "Nondeployment file in Web: " + name,
    );
  return files;
}
if (process.argv[2] === "mark-deployed") {
  const files = inventory(output);
  assert.ok(files["index.html"], "No complete Web build to record");
  assert.deepEqual(files, loadJson(manifestPath)?.files, "Web differs from the verified build");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(
    deployedPath,
    JSON.stringify({ at: new Date().toISOString(), files }, null, 2) + "\n",
  );
  updateChanges(files);
  console.log(
    JSON.stringify({
      deploymentBaselineRecorded: true,
      directory: "Web",
      files: Object.keys(files).length,
    }),
  );
} else if (process.argv[2] === "changes") {
  console.log(JSON.stringify(updateChanges(inventory(output)), null, 2));
} else if (process.argv[2] === "--qa") {
  // 검사용 빌드는 공개 미리보기가 내보내는 루트 Web/을 절대 건드리지 않는다.
  // (2026-09-24 총검수: pnpm build·격리 QA가 Web/을 production으로 덮어써 공개 미리보기가 바뀜)
  rmSync(qaOutput, { recursive: true, force: true });
  const files = buildVerifiedStage("preview", qaOutput);
  // 서버가 쓰는 정식 이용자 묶음도 관리자 코드 0인지 함께 검사한다.
  rmSync(qaProductionOutput, { recursive: true, force: true });
  const productionFiles = buildVerifiedStage("production", qaProductionOutput);
  // 관리자 화면은 별도 묶음이다. 관리자 화면 검수는 이 묶음으로 한다.
  rmSync(qaAdminOutput, { recursive: true, force: true });
  const adminFiles = buildVerifiedStage("production", qaAdminOutput, "admin");
  console.log(
    JSON.stringify({
      directory: ".local-runtime/qa-web",
      files: Object.keys(files).length,
      productionDirectory: ".local-runtime/qa-web-production",
      productionFiles: Object.keys(productionFiles).length,
      adminDirectory: ".local-runtime/qa-admin-web",
      adminFiles: Object.keys(adminFiles).length,
    }),
  );
} else {
  // 모드를 빠뜨리면 공개 미리보기 Web/을 production으로 덮어쓰지 않도록 멈춘다.
  const mode = process.argv[2] === "--mode" ? process.argv[3] : undefined;
  if (!["production", "preview"].includes(mode)) {
    console.error(
      "Web 빌드 모드가 없습니다. 'corepack pnpm web:build'(미리보기) 또는 'corepack pnpm web:build:production'(정식)을 쓰세요.",
    );
    process.exit(1);
  }
  mkdirSync(runtime, { recursive: true });
  const stage = contained(runtime, resolve(runtime, "stage-" + Date.now()));
  const previous = contained(runtime, resolve(runtime, "previous"));
  const before = inventory(output);
  if (existsSync(manifestPath)) {
    const managed = JSON.parse(readFileSync(manifestPath, "utf8")).files;
    assert.deepEqual(before, managed, "Web was edited outside the source build");
  }
  const files = buildVerifiedStage(mode, stage);
  if (existsSync(previous)) {
    inventory(previous);
    rmSync(previous, { recursive: true });
  }
  mkdirSync(previous, { recursive: true });
  copyVerified(output, previous, before);
  mkdirSync(output, { recursive: true });
  copyVerified(stage, output, files);
  const removed = Object.keys(before).filter((name) => !files[name]);
  for (const name of removed) rmSync(contained(output, resolve(output, name)));
  assert.deepEqual(inventory(output), files);
  const report = updateChanges(files, {
    mode,
    changes: {
      added: Object.keys(files).filter((name) => !before[name]).length,
      modified: Object.keys(files).filter(
        (name) => before[name] && before[name].sha256 !== files[name].sha256,
      ).length,
      removed: removed.length,
    },
  });
  writeFileSync(manifestPath, JSON.stringify({ at: report.at, mode, files }, null, 2) + "\n");
  rmSync(contained(runtime, stage), { recursive: true });
  console.log(
    JSON.stringify({
      directory: report.directory,
      files: report.fileCount,
      bytes: report.totalBytes,
      added: report.added.length,
      modified: report.modified.length,
      removed: report.removed.length,
      recommendation: report.recommendation,
      changeList: "OPERATIONS/web-deployment/changes.json",
    }),
  );
}
