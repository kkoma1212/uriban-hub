// 두 PC(이 PC·회사 노트북) GitHub 자동 동기화.
// 2026-10-11 사용자 결정: 한 번에 한 PC만 작업(A안) + 5분마다 자동 받기 + 공유 줄기 커밋은 즉시 올리기.
// 커밋은 자동으로 하지 않는다 — 작업 중인 코드·비밀값이 상대 PC로 넘어가지 않도록 커밋을 '보내기' 신호로 쓴다.
// 받기는 fast-forward만 한다 — 문서 DB(data/project-records.sqlite)는 양쪽 변경을 합칠 수 없으므로
// 기록이 엇갈리거나 작업 중인 파일과 겹치면 아무것도 바꾸지 않고 상태만 남긴다.
// 사용: node scripts/two-pc-sync.mjs receive | send | status
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 두 PC가 함께 쓰는 줄기. 바꿀 때는 사용자 결정 후 이 값과 AGENTS.md를 함께 고친다.
const SHARED_BRANCH = "codex/uriban-commercial-upgrade-20261010";
const REMOTE = "origin";
const NETWORK_TIMEOUT_MS = 60_000;
const LOCAL_TIMEOUT_MS = 15_000;
const LOG_KEEP_LINES = 300;
const IN_PROGRESS_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 예약 작업은 창 없이 돌기 때문에 로그인 창이 뜨면 끝없이 기다린다. 자격 증명이 없으면 묻지 말고 실패하게 한다.
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

function git(args, timeout = LOCAL_TIMEOUT_MS) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    env: gitEnv,
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitFailureText(error) {
  const detail = `${error.stderr ?? ""}${error.stdout ?? ""}`.trim() || error.message;
  return detail.split(/\r?\n/).slice(0, 6).join(" / ");
}

function syncFile(name) {
  return path.join(path.resolve(repoRoot, git(["rev-parse", "--git-common-dir"])), name);
}

function localTime() {
  return new Date().toLocaleString("sv-SE");
}

function record(result, detail = "") {
  const statusPath = syncFile("two-pc-sync.status.json");
  const logPath = syncFile("two-pc-sync.log");
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(statusPath, "utf8"));
  } catch {
    /* 첫 실행 */
  }
  const at = localTime();
  writeFileSync(statusPath, `${JSON.stringify({ at, result, detail })}\n`);
  const line = `${result}${detail ? ` — ${detail}` : ""}`;
  // 5분마다 같은 결과가 쌓이지 않게 결과가 바뀌었을 때만 이력에 남긴다.
  if (previous?.result !== result || previous?.detail !== detail) {
    appendFileSync(logPath, `${at} ${line}\n`);
    const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");
    if (lines.length > LOG_KEEP_LINES)
      writeFileSync(logPath, `${lines.slice(-LOG_KEEP_LINES).join("\n")}\n`);
  }
  console.log(`[두 PC 동기화] ${line}`);
}

function currentBranch() {
  try {
    return git(["symbolic-ref", "--short", "-q", "HEAD"]);
  } catch {
    return "";
  }
}

function operationInProgress() {
  return IN_PROGRESS_MARKERS.some((marker) =>
    existsSync(path.resolve(repoRoot, git(["rev-parse", "--git-path", marker]))),
  );
}

function sendToOtherPc() {
  if (currentBranch() !== SHARED_BRANCH) return;
  try {
    git(["push", "--quiet", REMOTE, `HEAD:refs/heads/${SHARED_BRANCH}`], NETWORK_TIMEOUT_MS);
  } catch (error) {
    // GitHub에 상대 PC 커밋이 먼저 있으면 거절된다. 다음 받기가 '엇갈림'으로 멈추고 사용자에게 넘긴다.
    return record("실패", `올리지 못함: ${gitFailureText(error)}`);
  }
  record("올림", git(["log", "-1", "--format=%h %s"]));
}

function receiveFromOtherPc() {
  const branch = currentBranch();
  if (branch !== SHARED_BRANCH)
    return record("건너뜀", `지금 줄기가 공유 줄기가 아님: ${branch || "(분리됨)"}`);
  if (operationInProgress()) return record("건너뜀", "병합·리베이스가 진행 중");
  try {
    git(["fetch", "--quiet", REMOTE, SHARED_BRANCH], NETWORK_TIMEOUT_MS);
  } catch (error) {
    return record("실패", `GitHub 확인 실패: ${gitFailureText(error)}`);
  }
  const [ahead, behind] = git([
    "rev-list",
    "--left-right",
    "--count",
    `HEAD...${REMOTE}/${SHARED_BRANCH}`,
  ])
    .split(/\s+/)
    .map(Number);
  if (ahead > 0 && behind > 0) {
    return record(
      "멈춤",
      `두 PC 기록이 엇갈림(이 PC ${ahead}개 · GitHub ${behind}개) — 어느 쪽을 살릴지 사용자가 결정`,
    );
  }
  if (behind > 0) {
    try {
      git(["merge", "--ff-only", "--quiet", `${REMOTE}/${SHARED_BRANCH}`]);
    } catch (error) {
      return record("멈춤", `받지 못함(작업 중인 파일과 겹침 등): ${gitFailureText(error)}`);
    }
    return record("받음", `상대 PC 커밋 ${behind}개`);
  }
  // 앞서 올리기에 실패해 이 PC에만 남은 커밋을 다시 올린다.
  if (ahead > 0) return sendToOtherPc();
  record("최신");
}

function showStatus() {
  let last = "기록 없음(아직 실행 전)";
  try {
    const status = JSON.parse(readFileSync(syncFile("two-pc-sync.status.json"), "utf8"));
    last = `${status.at} ${status.result}${status.detail ? ` — ${status.detail}` : ""}`;
  } catch {
    /* 기록 없음 */
  }
  console.log(`공유 줄기: ${SHARED_BRANCH}`);
  console.log(`지금 줄기: ${currentBranch() || "(분리됨)"}`);
  console.log(`마지막 자동 동기화: ${last}`);
  const logPath = syncFile("two-pc-sync.log");
  if (existsSync(logPath)) {
    console.log(
      `최근 이력:\n${readFileSync(logPath, "utf8").trimEnd().split("\n").slice(-10).join("\n")}`,
    );
  }
}

const commands = { receive: receiveFromOtherPc, send: sendToOtherPc, status: showStatus };
const run = commands[process.argv[2]];
if (!run) {
  console.error("사용: node scripts/two-pc-sync.mjs receive | send | status");
  process.exit(2);
}
try {
  run();
} catch (error) {
  try {
    record("실패", `예상 밖 오류: ${error.message}`);
  } catch {
    console.error(error.message);
  }
  process.exitCode = 1;
}
