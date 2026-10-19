// 서버 업데이트 묶음 조립 (T-ADMIN-SPLIT 5단계, 2026-10-07 사용자 결정).
//
//   node scripts/build-server-release.mjs build user|admin [커밋]
//   node scripts/build-server-release.mjs mark-deployed user|admin <커밋>
//
// 묶음은 GitHub에 올라간 커밋에서만 만든다(작업 폴더의 저장 안 한 수정·옛 자료가 섞이지 않게).
// 학생·교사 묶음(user)과 관리자 묶음(admin)을 따로 만들어 한쪽만 서버에 올릴 수 있게 한다.
// 결과: .local-runtime/server-release/<묶음>-<커밋>/ 에 이미지 파일·변경 목록·업데이트 안내.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { readServerReleaseConfiguration } from "./server-release-config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const releaseRoot = resolve(root, ".local-runtime/server-release");
const deployedPath = resolve(root, "OPERATIONS/server-release/deployed.json");

// Dockerfile 단계 → 서버에서 쓰는 이미지 이름(OPERATIONS/server-release/docker-compose.yml과 짝).
const TARGETS = {
  user: {
    label: "학생·교사 묶음",
    stages: {
      api: "classhub-api",
      worker: "classhub-worker",
      retention: "classhub-retention",
      operator: "classhub-operator",
    },
    screens: { image: "classhub-api", directory: "/app/Web", forbidden: "/app/AdminWeb" },
  },
  admin: {
    label: "관리자 묶음",
    stages: { "api-admin": "classhub-api-admin" },
    screens: { image: "classhub-api-admin", directory: "/app/AdminWeb", forbidden: "/app/Web" },
  },
};

// 이미지 빌드에 필요한 저장소 경로만 묶는다(.dockerignore도 함께 적용된다).
const CONTEXT_PATHS = [
  ".dockerignore",
  "Dockerfile",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "apps",
  "packages",
  "scripts",
  "db/migrations",
  "OPERATIONS/project-records/store.mjs",
  "data/project-records.sqlite",
  "THIRD_PARTY_NOTICES.json",
  "THIRD_PARTY_NOTICES.md",
  "THIRD_PARTY_LICENSES",
];

// 변경 목록을 사람이 읽기 좋게 나누는 기준. 위에서부터 처음 맞는 묶음에 넣는다.
const CHANGE_GROUPS = [
  ["DB 구조(주의 — 이 묶음만으로 적용되지 않음)", /^db\//u],
  [
    "관리자 화면",
    /^apps\/web\/(?:admin\/|src\/(?:features\/admin\/|admin-|api\/admin-|lib\/admin-))/u,
  ],
  ["화면 공용 설정·빌드", /^apps\/web\/(?:vite\.config\.ts|package\.json|scripts\/|tsconfig)/u],
  ["학생·교사 화면", /^apps\/web\//u],
  ["관리자 서버 기능", /^apps\/api\/src\/admin-/u],
  ["서버 프로그램(API)", /^apps\/api\//u],
  ["작업기·보관기간 정리·운영 명령", /^apps\/(?:worker|retention-cli|operator-cli)\//u],
  ["공용 패키지", /^packages\//u],
  ["의존성 목록", /^(?:pnpm-lock\.yaml|package\.json|pnpm-workspace\.yaml)$/u],
  ["배포 설정", /^(?:Dockerfile|\.dockerignore|OPERATIONS\/server-release\/)/u],
];

const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
const docker = (...args) =>
  execFileSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const loadDeployed = () =>
  existsSync(deployedPath) ? JSON.parse(readFileSync(deployedPath, "utf8")) : {};

function targetFrom(value) {
  assert.ok(Object.hasOwn(TARGETS, value ?? ""), "묶음은 user 또는 admin 이어야 합니다.");
  return value;
}

function resolvePushedCommit(reference) {
  const commit = git("rev-parse", "--verify", `${reference}^{commit}`);
  // GitHub에 없는 커밋으로는 만들지 않는다 — 서버에 올라간 것과 저장소 기록이 늘 같게.
  assert.notEqual(
    git("branch", "-r", "--contains", commit),
    "",
    `커밋 ${commit.slice(0, 10)}이(가) GitHub에 올라가 있지 않습니다. 먼저 push 하세요.`,
  );
  return commit;
}

function groupChanges(fromCommit, toCommit) {
  if (!fromCommit) return { baseline: null, groups: {}, other: 0 };
  const lines = git("diff", "--name-status", "--no-renames", `${fromCommit}..${toCommit}`)
    .split("\n")
    .filter(Boolean);
  const groups = {};
  let other = 0;
  for (const line of lines) {
    const [status, path] = line.split("\t");
    const group = CHANGE_GROUPS.find(([, pattern]) => pattern.test(path));
    if (!group) {
      other += 1;
      continue;
    }
    (groups[group[0]] ??= []).push(
      `${{ A: "추가", M: "수정", D: "삭제" }[status] ?? status} ${path}`,
    );
  }
  return { baseline: fromCommit, groups, other };
}

function screenInventory(image, directory) {
  const listing = docker(
    "run",
    "--rm",
    "--entrypoint",
    "sh",
    image,
    "-c",
    `cd ${directory} && find . -type f | sort | xargs sha256sum`,
  );
  return Object.fromEntries(
    listing
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, path] = line.split(/\s+/u);
        return [path.replace(/^\.\//u, ""), hash];
      }),
  );
}

function verifyImages(target, tags) {
  const { screens } = TARGETS[target];
  const image = tags[screens.image];
  const files = screenInventory(image, screens.directory);
  assert.ok(Object.keys(files).length > 0, "이미지에 화면 파일이 없습니다.");
  const missing = spawnSync(
    "docker",
    ["run", "--rm", "--entrypoint", "sh", image, "-c", `test ! -e ${screens.forbidden}`],
    { windowsHide: true },
  );
  assert.equal(
    missing.status,
    0,
    `${image}에 다른 묶음의 화면(${screens.forbidden})이 들어 있습니다.`,
  );
  if (target === "user") {
    const adminFiles = Object.keys(files).filter((path) =>
      /(?:^|\/)admin|\/api\/v1\/admin/iu.test(path),
    );
    assert.deepEqual(adminFiles, [], "학생·교사 화면에 관리자 파일이 있습니다.");
    assert.ok(files["index.html"], "학생·교사 화면 입구(index.html)가 없습니다.");
  } else {
    assert.ok(files["admin/index.html"], "관리자 화면 입구(admin/index.html)가 없습니다.");
  }
  // 사진 처리(sharp)는 리눅스용 바이너리가 있어야 한다.
  docker(
    "run",
    "--rm",
    "--entrypoint",
    "node",
    image,
    "-e",
    "import('sharp').then(()=>process.exit(0))",
  );
  return files;
}

function updateGuide(target, short, archiveName, archiveSha) {
  const { label, stages } = TARGETS[target];
  const services = target === "user" ? "api worker" : "api-admin";
  const releaseVariable = target === "user" ? "USER_RELEASE" : "ADMIN_RELEASE";
  const profile = target === "admin" ? "--profile admin " : "";
  return `우리반 허브 ${label} 업데이트 — 커밋 ${short}

[이 묶음에 든 것]
${Object.values(stages)
  .map((name) => `- ${name}:${short}`)
  .join("\n")}
바뀐 내용은 CHANGES.txt 를 본다. 이 묶음은 ${target === "user" ? "관리자 프로그램(api-admin)" : "학생·교사 프로그램(api·worker)"}을 바꾸지 않는다.
${target === "admin" ? "\n※ 관리자 프로그램은 학생·교사 주소와 다른 관리자 주소(.env ADMIN_DOMAIN, 기본 admin.<DOMAIN>)에서만 기동한다. 그 주소의 DNS·인증서·nginx·접속 제한을 먼저 마친다.\n" : ""}
[설치 권한 확인 — 기존 분리 구성 업데이트에도 필수]
회사 서버의 실제 설치 상태는 이 묶음에서 확인하지 않았다. 설치 책임자가 자료함 표 및
app 계정의 teacher_library_items SELECT·INSERT·DELETE 딱 3권한을 먼저 확인한다.
정확하게 설치돼 있으면 .env TEACHER_LIBRARY_DATABASE_INSTALLED=true,
검증된 기존93 설치에 이 표·권한이 없으면 false를 지정한다. 미확인·불일치면 업데이트를 중단한다.
이 묶음으로 DDL이나 권한을 임의 보정하지 않는다.
확인 뒤 기존 docker-compose.yml을 백업하고 config/docker-compose.yml의 공통 API 설정
TEACHER_LIBRARY_DATABASE_INSTALLED의 필수 환경값 참조를 기존 구성에 반영한다(주소·설정 보존).
이 공통 값은 api와 api-admin 양쪽에 전달된다. 반대쪽 이미지는 바꾸거나 재기동하지 않는다.
구버전 API는 알지 못하는 새 설정을 무시하므로 기존 권한 프로필이 바뀌지 않는다.
반대쪽 API를 나중에 재기동·업데이트할 때에도 설치 권한과 해당 버전의 프로필을 먼저 대조한다.
자료함 기능 활성화 값이 아니다.
동봉 db-init.sh는 기존78표·93원장용이며 신규95 설치 SQL과 호환되지 않는다.
신규95는79표·95원장·TLS 필수5계정 사전준비 계약이다. 기존 초기화로 설치하거나
REQUIRE NONE으로 완화하지 않는다. 별도 원문SQL·TLS·정확스키마/권한 검증이 필요하다.
기존93의 업데이트 성공은 신규95 회사 출시 검증을 통과한 증거가 아니다.
config/docker-compose.first95-tls.yml 및 env.first95.example이 포함된 커밋이면,
이는 별도 설치·검증이 끝난 신규95 DB에 연결하는 독립 구성 후보다.
기존 docker-compose.yml과 병합하거나 기존93 업데이트에 사용하지 않는다.
신규95 담당자는 DSN·CA·이미지·법률/메일 설정을 확인한 뒤 이 파일만 명시한다.
이 구성은 DB 서버·계정·TLS 인증서를 생성하지 않으며 기존 db-init을 실행하지 않는다.
실제 Compose 설정 검사·회사 서비스 접속 결과가 없으면 운영 적용 완료로 표시하지 않는다.
신규95 연결 구성 검토는 아래 별도 명령으로 한다(비밀값은 담당자의 private.env에 보관).
   docker compose --env-file private.env -f config/docker-compose.first95-tls.yml --profile '*' config --quiet
이 검사는 인증서 연결·이미지 실행을 검증하지 않는다. 이 업데이트 묶음 하나로 모든5서비스가
갖춰졌다고 가정하지 말고 나머지 검토된 이미지·관리자 주소·TLS·기존 서비스 구성을 확인한다.
config/docker-compose.runtime-observation.yml은 신규95 독립 구성에만 더하는 진단 후보이다.
env.runtime-observation.example의 새 challenge와 서비스별 private Linux 디렉터리를 준비하고,
   docker compose --env-file private.env -f config/docker-compose.first95-tls.yml -f config/docker-compose.runtime-observation.yml --profile '*' config --quiet
로 먼저 설정을 검사한다. 기존 db-init 구성에 병합하지 않는다. 실제 실행 사용자 소유·0700·
symlink 없는 디렉터리만 사용하며 존재하지 않는 host 경로를 자동 생성하지 않는다.
정리·운영 도구는 observe-database로만 실행되어 업무조회/삭제/입력토큰을 요청하지 않는다.
Linux private-file 기능 검증과 process-local PID·이미지·소스·보호된 실행 증거 결합은 별도다.
이 구성파일 또는 계정 연결 성공만으로 출시 승인이나 실제5서비스 검증을 보고하지 않는다.
되돌릴 때 해당 이미지와 compose 백업을 함께 대조한다.

[기존93 구성 업데이트 적용] docker-compose.yml 이 있는 우리반 허브 묶음 폴더에서
1) 파일 확인·불러오기
   sha256sum ${archiveName}        → ${archiveSha}
   docker load -i ${archiveName}
2) .env 의 ${releaseVariable} 를 ${short} 로 바꾼다(처음이면 줄을 추가).
3) 해당 서비스만 다시 올린다
   docker compose ${profile}up -d ${services}
   docker compose ps
4) 확인
${target === "user" ? "   curl -s https://<DOMAIN>/login | grep -o '<title>[^<]*'      → 우리반 허브\n   curl -s -o /dev/null -w '%{http_code}\\n' https://<DOMAIN>/api/v1/bootstrap   → 401" : '   curl -s http://127.0.0.1:3002/healthz   → {"status":"ok"}'}

[되돌리기]
.env 의 ${releaseVariable} 를 직전 커밋 번호로 되돌리고  docker compose ${profile}up -d ${services}
(직전 이미지는 docker image ls 로 남아 있는지 확인. 지우지 않았다면 다시 불러올 필요 없다.)

[처음 분리 구성으로 바꿀 때만]
config/ 의 docker-compose.yml 로 기존 파일을 바꾼다(기존 파일은 docker-compose.yml.before-split 으로 보관).
.env 에 USER_RELEASE= 줄을 추가한다(config/env.example 참고). db/·docker/mariadb/·.env 는 그대로 둔다.
`;
}

async function build(target, reference = "HEAD") {
  const commit = resolvePushedCommit(reference);
  const short = commit.slice(0, 10);
  const outDir = resolve(releaseRoot, `${target}-${short}`);
  assert.equal(existsSync(outDir), false, `이미 만든 묶음이 있습니다: ${outDir}`);
  const dirty = git("status", "--porcelain", "--", ...CONTEXT_PATHS);
  if (dirty)
    console.log("참고: 작업 폴더의 저장 안 한 수정은 묶음에 들어가지 않습니다(커밋 기준).");

  mkdirSync(outDir, { recursive: true });
  const contextTar = resolve(outDir, "context.tar");
  git("archive", "--format=tar", "-o", contextTar, commit, "--", ...CONTEXT_PATHS);

  const tags = {};
  for (const [stage, name] of Object.entries(TARGETS[target].stages)) {
    const tag = `${name}:${short}`;
    const input = openSync(contextTar, "r");
    const result = spawnSync(
      "docker",
      [
        "build",
        "--file",
        "Dockerfile",
        "--target",
        stage,
        "--build-arg",
        `SOURCE_REVISION=${commit}`,
        "--tag",
        tag,
        "-",
      ],
      { cwd: root, stdio: [input, "inherit", "inherit"], windowsHide: true },
    );
    closeSync(input);
    assert.equal(result.status, 0, `이미지 빌드 실패: ${tag}`);
    tags[name] = tag;
  }
  rmSync(contextTar);

  const screenFiles = verifyImages(target, tags);
  const images = Object.fromEntries(
    Object.values(tags).map((tag) => [tag, docker("image", "inspect", "--format", "{{.Id}}", tag)]),
  );

  const archiveName = `classhub-${target}-${short}.tar.gz`;
  const imageTar = resolve(outDir, "images.tar");
  docker("save", "-o", imageTar, ...Object.values(tags));
  await pipeline(
    createReadStream(imageTar),
    createGzip({ level: 6 }),
    createWriteStream(resolve(outDir, archiveName)),
  );
  rmSync(imageTar);
  const archiveSha = sha256File(resolve(outDir, archiveName));

  const deployed = loadDeployed()[target];
  const changes = groupChanges(deployed?.commit, commit);
  const changeText = [
    `${TARGETS[target].label} ${short} — 직전 배포 ${changes.baseline ? changes.baseline.slice(0, 10) : "기록 없음(첫 분리 배포)"} 이후 바뀐 것`,
    "",
    ...Object.entries(changes.groups).flatMap(([group, files]) => [
      `■ ${group} (${files.length})`,
      ...files.map((file) => `  ${file}`),
      "",
    ]),
    changes.other ? `그 밖의 문서·검사 파일 ${changes.other}개(서버 묶음과 무관)` : "",
  ].join("\n");

  // 이 커밋의 서버 설정을 함께 넣는다(처음 분리 구성으로 바꿀 때 쓴다).
  mkdirSync(resolve(outDir, "config/docker"), { recursive: true });
  for (const { path, bytes } of readServerReleaseConfiguration({ repositoryRoot: root, commit })) {
    writeFileSync(resolve(outDir, "config", path), bytes);
  }
  writeFileSync(resolve(outDir, "CHANGES.txt"), changeText + "\n");
  writeFileSync(resolve(outDir, "UPDATE.txt"), updateGuide(target, short, archiveName, archiveSha));
  writeFileSync(
    resolve(outDir, "release.json"),
    JSON.stringify(
      {
        target,
        commit,
        builtAt: new Date().toISOString(),
        images,
        archive: { name: archiveName, sha256: archiveSha },
        screens: {
          directory: TARGETS[target].screens.directory,
          files: Object.keys(screenFiles).length,
          sha256: screenFiles,
        },
        changesSince: changes.baseline,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        target,
        commit: short,
        outDir,
        archive: archiveName,
        archiveSha256: archiveSha,
        images: Object.keys(images),
        screenFiles: Object.keys(screenFiles).length,
        changeGroups: Object.fromEntries(
          Object.entries(changes.groups).map(([k, v]) => [k, v.length]),
        ),
      },
      null,
      2,
    ),
  );
}

function markDeployed(target, reference) {
  assert.ok(reference, "실제로 서버에 올린 커밋 번호가 필요합니다.");
  const commit = resolvePushedCommit(reference);
  const deployed = loadDeployed();
  deployed[target] = { commit, deployedAt: new Date().toISOString() };
  writeFileSync(deployedPath, JSON.stringify(deployed, null, 2) + "\n");
  console.log(JSON.stringify({ deployed: target, commit: commit.slice(0, 10) }));
}

const [command, targetArgument, reference] = process.argv.slice(2);
if (command === "build") await build(targetFrom(targetArgument), reference);
else if (command === "mark-deployed") markDeployed(targetFrom(targetArgument), reference);
else {
  console.error(
    "사용법: node scripts/build-server-release.mjs build user|admin [커밋]  /  mark-deployed user|admin <커밋>",
  );
  process.exit(1);
}
