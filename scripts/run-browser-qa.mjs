/*
 * 브라우저 QA 전수 실행기 (T-HUB-34).
 *
 * **왜 만들었나**: 화면을 실제로 여는 e2e QA 가 게이트에 하나도 없었다. 그래서 아무도
 * 안 돌렸고, 2026-08-18에 재 보니 19개 중 6개가 낡아서 깨져 있었다 — 그중 5개는
 * 2026-08-12에 「투표」가 주요 메뉴의 독립 칸이 된 것 하나를 못 따라간 것이었다.
 * 엿새 동안 아무도 몰랐다. 이 저장소는 낡은 QA 를 되살리다 세션을 통째로 쓴 적이
 * 세 번 있다 — 안 썩게 막는 편이 훨씬 싸다.
 *
 * **목록을 손으로 적지 않는다**: 손으로 적으면 새 QA 를 또 빠뜨리고 같은 일이 반복된다.
 * `startNormalSyntheticRuntime` 을 스스로 부르는 파일 = 혼자 돌 수 있는 QA 로 보고 전부
 * 집는다. 이 판정은 "혼자 돌 수 있는가"라는 기능적 사실이라 이름 규칙보다 덜 낡는다.
 *
 * **하나씩 돌린다**: 동시에 돌리면 testcontainer 가 경합해 지문이 섞인다(T-HUB-03).
 *
 * ⚠️ **이 파일은 `node --import tsx` 로 실행해야 한다**(package.json 참조). 공유 런타임을
 * 쓰려고 `normal-synthetic-runtime.mjs` 를 불러오는데 그 안이 TypeScript 를 타고 들어간다.
 * 맨 `node` 로 돌리면 거기서 `ERR_MODULE_NOT_FOUND` 로 죽는다 — 2026-08-19에 실제로
 * 그렇게 죽어서, 앞의 21개가 통과한 뒤 공유 런타임 몫 6개가 통째로 안 돌았다.
 */
import { readdir, readFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const browserQaDirectory = join(repositoryRoot, "browser-qa");

/* 24시간 상주하는 검수용 호스트다 — 게이트에서 돌리면 끝나지 않는다. */
const HOSTS = new Set(["host-normal-synthetic-runtime.mjs", "host-chatgpt-live-review.mjs"]);
const PER_QA_TIMEOUT_MILLISECONDS = 15 * 60 * 1000;

/*
 * "서버를 자기가 띄우는가"를 알아보는 표식. 이 중 하나라도 있으면 혼자 돌 수 있다.
 * 마지막 것은 API 시험 하네스를 직접 쓰는 부류다(`app`·`database` 를 받아 온다).
 * 새 방식이 생기면 여기 한 줄 더한다 — 실측으로 확인한 뒤에.
 */
const RUNTIME_STARTERS = [
  "startNormalSyntheticRuntime(",
  "startOnboardingRoleRuntime(",
  "apps/api/test/supplies-test-harness",
];

/*
 * "이미 떠 있는 앱 주소를 받아 쓰는" 부류의 표식. 이것들은 자기 서버를 안 띄우므로
 * **우리가 런타임 하나를 띄워 주소를 물려준다** — 여덟이 한 런타임을 나눠 쓰니
 * 각자 띄우는 것보다 싸다.
 *
 * ⚠️ `role-readonly-e2e-qa` 와 `session-role-probe` 는 여기 안 걸린다(둘은 `--app-origin`
 * 인자를 쓴다). **일부러 넣지 않았다** — 그 둘은 `--confirm-isolated-session` 이라는
 * 사람 확인 플래그를 요구한다("인증된 GET 이 세션 상태를 바꿀 수 있다"). 게이트가
 * 자동으로 돌리면 그 안전장치를 우회하는 셈이다.
 */
const HOST_ORIGIN_MARKER = "CLASSHUB_APP_ORIGIN";

/*
 * **격리 — 지금은 못 돌리는 것.** 조용히 빼지 않고 이름·사유·날짜를 남긴다.
 * 여기 있는 동안 그 QA 는 계속 썩는다는 뜻이므로, 늘어나면 그 자체가 신호다.
 */
const QUARANTINE = new Map([
  [
    "layout-tabs-e2e-qa.mjs",
    "2026-09-12 P-016: 제외된 자리·모둠·당번을 포함한 이전 배치 탭 계약. 파일 보존.",
  ],
  /*
   * 2026-10-03 T-BROWSER-QA-DRIFT(사용자 결정: 이름만 낡은 것은 고치고, 계약을 새로 써야 하는
   * 것은 격리 + 후속 과업). 아래는 9/27 확정 시안·9/30 관리자 개편으로 화면 구조가 바뀌어
   * 무엇을 지킬지부터 다시 정해야 하는 것들이다. 후속: BACKLOG T-BROWSER-QA-REWRITE.
   */
  [
    "wave3-navigation-responsive-qa.mjs",
    "2026-10-04 은퇴(사용자 결정, 파일 보존): 옛 탭(오늘·알림·반 활동)·위치 표시(오늘›알림›공지) 계약. 지금은 홈·소식·일정·급식·더보기에 위치 표시 없음 — 위치 표시 없음·현재 탭 하나는 theme-responsive, 메뉴 칸 수는 run-isolated-wave1이 지킴.",
  ],
  /*
   * ✅ 2026-08-20: `run-isolated-wave1` 을 격리에서 풀었다. "84개 화면이 실패하는 손 못 댈
   * 물건"으로 보였으나 **낡은 값 두 곳**이었다(주요 메뉴 칸 수 6/5 → 7/6). 고치니
   * 15분 → **98초**, 실패 0. 모든 화면이 "영영 준비 안 됨"으로 판정돼 화면마다 8초씩
   * 헛기다린 것이 그 시간의 정체였다.
   */
  /*
   * ✅ 2026-08-20: `run-isolated-content-updates` 와 `student-mobile-logout-e2e-qa` 를
   * 격리에서 풀었다. "아침엔 됐는데 저녁엔 안 되던" 원인은 **포트 5173 충돌**이었다 —
   * 이 PC 의 다른 프로젝트가 그 포트를 쓰기 시작하자 검수가 남의 앱을 열었다.
   * `wave1-fixture-runtime` 이 빈 포트를 직접 잡도록 고쳐서 해결했다.
   */
  /*
   * ✅ 2026-08-20: `wave4-ui-remediation-qa` 도 풀었다. "겹겹이"로 보였던 세 겹이 전부
   * **같은 뿌리**였다 — 알림 머리글 · 준비물 빈 문구 · 탭 이동 순서(「투표」가 「알림」
   * 다음 칸으로 들어와 뒤가 한 칸씩 밀렸다).
   *
   * 당시 격리 목록이 비었다. 다시 채워야 할 일이 생기면 이름·사유·날짜를 반드시
   * 남길 것 — 조용히 빼면 이 실행기가 거짓 안전망이 된다.
   */
]);

const FULL_CONTRACT = "완전 계약";

/*
 * **등급 — "통과 31개"가 감추는 것.**
 *
 * 이 실행기는 종료 코드만 센다. 그 QA 가 *무엇을* 강제하는지는 모른다. 2026-08-22
 * 감사에서 그 틈이 실제로 드러났다: `elections-e2e-qa` 는 "발표한 뒤 학생에게 결과가
 * **안 보이면** 통과"라고 적고 있었다 — 제품 결함(T-HUB-45)을 오히려 통과 조건으로
 * 못박은 것이다. 통과 수만 세는 한 이런 것은 영영 안 보인다.
 *
 * 등급은 기계가 못 정한다(코드의 *의미*를 읽어야 한다). 그래서 손으로 적되,
 * **목록에 없는 QA 가 나타나면 게이트를 막는다.** 손 목록이 낡는 것을 막는 유일한 길이고,
 * 새 QA 를 만들 때 한 줄 적는 값은 싸다. (자동 수집으로 푼 T-HUB-34 와 다른 점 —
 * "혼자 돌 수 있는가"는 기계가 알지만 "무엇을 강제하는가"는 못 안다.)
 *
 * ⚠️ **출처**: 아래 분류는 2026-08-22 감사 §3.2 를 옮긴 것이다. 31개를 각각 다시 읽어
 * 재판정한 것이 아니다. 틈 설명이 실제와 어긋나면 그 줄을 고칠 것.
 */
const COVERAGE = new Map([
  [
    "common-frame-qa.mjs",
    "부분 — 합성 서버에서 교사·학생 공통 화면 틀(머리·본문·약관줄)의 위치·스크롤·잘림을 여러 폭에서 검사하고 어긋나면 실패한다. 실제 운영 데이터 모양은 보지 않는다",
  ],
  [
    "inner-alignment-qa.mjs",
    "부분 — 측정 전용: 탭·첫 상세·도움 대화·반 대화 72화면의 카드 안쪽 시작선·끝선 차이를 기록하고 사진을 남긴다. 차이가 있어도 실패로 막지 않는다(대화 말풍선 등 의도된 차이 포함 — 사람이 판정)",
  ],
  [
    "tab-frame-alignment-qa.mjs",
    "부분 — 합성 서버에서 38개 탭 화면의 머리 높이·본문 시작선·긴 목록 끝까지 스크롤을 검사하고 어긋나면 실패한다. 상세·대화 화면 안쪽은 inner-alignment-qa 범위",
  ],
  [
    "admin-auth-layout-qa.mjs",
    "부분 — 브라우저 API 대역으로 관리자 로그인·TOTP 등록·계정 화면의 반응형 배치와 44px 조작 영역을 검사한다. 실제 인증·MFA 서버 검증은 별도 통합 테스트 범위",
  ],
  [
    "admin-console-layout-qa.mjs",
    "부분 — 브라우저 API 대역으로 관리자 역할별 탭·조회/쓰기 UI 노출·반응형 배치를 검사한다. 실제 서버 권한과 데이터 변경은 별도 통합 테스트 범위",
  ],
  [
    "account-experience-e2e-qa.mjs",
    "부분 — 격리 SMTP·가입 승인·재설정·재참여·요청 제한·복사와 대표 역할 화면을 검증한다. 관리자 MFA 로그인·모든 제품 화면은 별도 QA 범위",
  ],
  ["attendance-notifications-e2e-qa.mjs", FULL_CONTRACT],
  ["cross-tab-auth-state-e2e-qa.mjs", FULL_CONTRACT],
  /* 2026-08-22: 발표 결과·득표 공개를 학생 화면에서 실제로 재게 되어 등급을 올렸다. */
  ["elections-e2e-qa.mjs", FULL_CONTRACT],
  ["homework-category-e2e-qa.mjs", "부분 — 완료·재알림·교사 후속확인의 분류 보존은 안 본다"],
  ["layout-tabs-e2e-qa.mjs", FULL_CONTRACT],
  ["logout-login-e2e-qa.mjs", FULL_CONTRACT],
  ["mobile-login-layout-qa.mjs", FULL_CONTRACT],
  ["polls-e2e-qa.mjs", FULL_CONTRACT],
  ["reminder-aggregate-e2e-qa.mjs", FULL_CONTRACT],
  [
    "round5-alignment-qa.mjs",
    "부분 — 좌우선·짝 카드 높이·달력 요일 의미·명단 정렬/검색·44px 을 좌표로 잰다. " +
      "다크·고대비는 1440 일정 화면 한 곳에서만 보고, 알림·활동 화면의 색 회귀는 안 본다",
  ],
  /* 2026-10-04 재작성: 9/27 화면에서 사라진 학생 홈 우선 칸·목록 카드 받는 대상 표시는 빠졌다. */
  [
    "run-isolated-content-updates.mjs",
    "부분 — 지정 학생 공지·준비물 작성(받는 사람 창·게시 전 검토)·교사 상세의 받는 사람·필터·지정/비지정 학생 노출·직접 경로 차단·DB 기록을 본다. 목록 카드의 받는 대상 표시와 학생 홈 배치는 보지 않는다",
  ],
  ["run-isolated-guardian-consent-e2e.mjs", FULL_CONTRACT],
  ["run-isolated-onboarding-role-e2e.mjs", FULL_CONTRACT],
  ["run-isolated-wave1.mjs", FULL_CONTRACT],
  ["schedule-write-e2e-qa.mjs", FULL_CONTRACT],
  ["student-assessment-navigation-qa.mjs", FULL_CONTRACT],
  ["student-assessments-e2e-qa.mjs", FULL_CONTRACT],
  ["student-home-e2e-qa.mjs", FULL_CONTRACT],
  ["student-mobile-logout-e2e-qa.mjs", FULL_CONTRACT],
  ["theme-responsive-qa.mjs", FULL_CONTRACT],
  ["uiux-baseline-measure.mjs", "측정만 — 수치를 재서 남길 뿐 임계값으로 실패시키지 않는다"],
  ["wave1-calendar-qa.mjs", FULL_CONTRACT],
  ["wave1-member-detail-qa.mjs", "부분 — 실제 저장은 하지 않는다(읽기·서식·접근성까지)"],
  ["wave1-school-details-qa.mjs", FULL_CONTRACT],
  ["wave3-idempotency-qa.mjs", FULL_CONTRACT],
  ["wave3-navigation-responsive-qa.mjs", FULL_CONTRACT],
  ["wave3-screen-state-qa.mjs", FULL_CONTRACT],
  ["wave4-ui-remediation-qa.mjs", FULL_CONTRACT],
  ["wave5-retained-shell-qa.mjs", FULL_CONTRACT],
]);

/**
 * 혼자 돌 수 있는 진입점을 찾는다.
 * - 자기 런타임을 띄우는 파일
 * - `run-isolated-*` 실행 껍데기(런타임·tsconfig 를 갖춰 진짜 QA 를 대신 띄운다)
 * 껍데기가 대신 띄우는 파일(worker)은 직접 돌리면 안 되므로 뺀다.
 */
async function discoverSelfContainedQa() {
  const entries = (await readdir(browserQaDirectory))
    .filter((name) => name.endsWith(".mjs") && !HOSTS.has(name))
    .sort();
  const sources = new Map();
  for (const name of entries) {
    sources.set(name, await readFile(join(browserQaDirectory, name), "utf8"));
  }

  const runners = entries.filter(
    (name) => name.startsWith("run-isolated-") && !name.endsWith("-worker.mjs"),
  );
  const workers = new Set();
  for (const runner of runners) {
    for (const [, referenced] of sources.get(runner).matchAll(/"([a-z0-9-]+\.mjs)"/gu)) {
      if (referenced !== runner) workers.add(referenced);
    }
  }

  const selected = [];
  const hostBased = [];
  const skipped = [];
  const quarantined = [];
  for (const name of entries) {
    if (QUARANTINE.has(name)) {
      quarantined.push(name);
      continue;
    }
    if (workers.has(name)) {
      skipped.push(name);
      continue;
    }
    const source = sources.get(name);
    if (runners.includes(name) || RUNTIME_STARTERS.some((marker) => source.includes(marker))) {
      selected.push(name);
    } else if (source.includes(HOST_ORIGIN_MARKER)) {
      hostBased.push(name);
    } else {
      skipped.push(name);
    }
  }
  return { hostBased, quarantined, selected, skipped };
}

function runOne(name, extraEnvironment = {}, { typescriptLoader = true } = {}) {
  return new Promise((resolvePromise) => {
    /*
     * ⚠️ 더할 것이 없으면 `env` 를 아예 주지 않는다. `{ ...process.env }` 로 통째로
     * 복사해 넘겼더니 `.ts` 를 읽던 QA 셋이 `ERR_MODULE_NOT_FOUND` 로 죽었다 —
     * tsx 가 쓰는 설정이 그 과정에서 어긋난다. 물려받게 두면 그대로 돈다.
     */
    const entrypoint = join(browserQaDirectory, name);
    const childArguments = typescriptLoader ? ["--import", "tsx", entrypoint] : [entrypoint];
    const child = spawn(process.execPath, childArguments, {
      cwd: repositoryRoot,
      windowsHide: true,
      ...(Object.keys(extraEnvironment).length === 0
        ? {}
        : { env: { ...process.env, ...extraEnvironment } }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), PER_QA_TIMEOUT_MILLISECONDS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, output, signal });
    });
  });
}

/** 실패 원인 한 줄. 보고서 JSON 의 failure 를 먼저 보고, 없으면 첫 오류 줄을 쓴다. */
function failureHint(output) {
  const reported = /"(?:failure|executionError)": "((?:[^"\\]|\\.)*)"/u.exec(output);
  if (reported !== null) return reported[1].replaceAll("\\n", " ").slice(0, 200);
  const thrown = /^.*(?:Error|Timed out|Could not).*$/mu.exec(output);
  return thrown === null ? "(원인 줄을 찾지 못했다 — 전체 출력을 볼 것)" : thrown[0].slice(0, 200);
}

const { hostBased, quarantined, selected, skipped } = await discoverSelfContainedQa();
const total = selected.length + hostBased.length;

/*
 * 건너뛴 것을 조용히 감추지 않는다 — "전부 돌렸다"고 잘못 읽히면 이 실행기 자체가
 * 거짓 안전망이 된다.
 */
process.stdout.write(
  `브라우저 QA 전수 실행 — ${total}개 (자기 서버 ${selected.length} · 공유 런타임 ${hostBased.length})\n`,
);
if (skipped.length > 0) {
  process.stdout.write(
    `⚠️ 못 넣은 ${skipped.length}개:\n   ${skipped.join(", ")}\n` +
      `   (껍데기가 대신 돌리는 것 / 사람 확인 플래그를 요구하는 것 / 제품에 없는 기능을 기대하는 것)\n`,
  );
}

/*
 * 등급을 먼저 보여 준다 — 뒤에 "31개 전부 통과"가 찍히므로, 그 말이 무슨 뜻인지
 * 알고 읽게 해야 한다. 분류가 없는 QA 는 게이트를 막는다(위 COVERAGE 주석 참조).
 */
const graded = [...selected, ...hostBased];
const ungraded = graded.filter((name) => !COVERAGE.has(name));
if (ungraded.length > 0) {
  process.stdout.write(
    `\n❌ 등급이 없는 QA ${ungraded.length}개: ${ungraded.join(", ")}\n` +
      `   scripts/run-browser-qa.mjs 의 COVERAGE 에 한 줄 적을 것 — 무엇을 강제하고\n` +
      `   무엇을 안 보는지 적지 않으면 "전부 통과"가 무슨 뜻인지 아무도 모른다.\n`,
  );
  process.exit(1);
}
const gaps = graded.filter((name) => COVERAGE.get(name) !== FULL_CONTRACT);
process.stdout.write(`등급: 완전 계약 ${graded.length - gaps.length} · 틈 있음 ${gaps.length}\n`);
for (const name of gaps) process.stdout.write(`   · ${name}: ${COVERAGE.get(name)}\n`);
for (const name of quarantined) {
  process.stdout.write(`🚧 격리 중 — ${name}: ${QUARANTINE.get(name)}\n`);
}
process.stdout.write("\n");

const failures = [];
/* 한 번 죽었다가 재시도로 살아난 것. 조용히 넘기면 이 장치가 진짜 결함을 덮는다. */
const revived = [];
let index = 0;

async function attempt(name, extraEnvironment, options) {
  const startedAt = process.hrtime.bigint();
  const { code, output, signal } = await runOne(name, extraEnvironment, options);
  const seconds = Number((process.hrtime.bigint() - startedAt) / 1_000_000n) / 1000;
  const timedOut = signal === "SIGKILL";
  return {
    hint: timedOut ? "15분 시간초과" : failureHint(output),
    output,
    passed: code === 0 && !timedOut,
    seconds,
    verdict: code === 0 && !timedOut ? "통과" : timedOut ? "시간초과" : `실패(${code})`,
  };
}

async function runGroup(names, extraEnvironment, options) {
  for (const name of names) {
    index += 1;
    const first = await attempt(name, extraEnvironment, options);
    if (first.passed) {
      process.stdout.write(
        `[${index}/${total}] ${name.padEnd(40)} 통과     ${first.seconds.toFixed(0)}초\n`,
      );
      continue;
    }

    /*
     * **재시도는 한 번뿐이다**(2026-08-19 Hex 결정). 이 스위트는 부하가 걸리면
     * 서로 다른 QA 가 시간초과로 흔들린다 — 매번 다른 자리에서, 단독으로는 통과한다
     * (T-HUB-27 과 같은 계열). 진짜 결함은 두 번 다 죽으므로 그것만 게이트를 막는다.
     * ⚠️ **살아난 것은 반드시 크게 찍는다.** 재시도가 조용하면 간헐 결함이 영영
     * 안 보이게 되고, 그러면 이 장치가 거짓 안전망이 된다.
     */
    process.stdout.write(
      `[${index}/${total}] ${name.padEnd(40)} ${first.verdict.padEnd(8)} ${first.seconds.toFixed(0)}초 → 재시도\n`,
    );
    process.stdout.write(`\n=== ${name} 첫 실패 출력 ===\n${first.output}\n`);
    const second = await attempt(name, extraEnvironment, options);
    if (second.passed) {
      process.stdout.write(
        `${" ".repeat(9)}${name.padEnd(40)} 재시도 통과 ${second.seconds.toFixed(0)}초\n`,
      );
      revived.push({ hint: first.hint, name });
    } else {
      process.stdout.write(
        `${" ".repeat(9)}${name.padEnd(40)} ${second.verdict.padEnd(8)} ${second.seconds.toFixed(0)}초 (두 번 다 실패)\n`,
      );
      failures.push({ hint: second.hint, name, output: second.output });
    }
  }
}

/*
 * QA 화면 서버(static-web-runtime)는 루트 Web/이 아니라 검사용 빌드를 내보낸다.
 * 공개 미리보기가 쓰는 Web/을 QA가 바꾸지 않게 하려는 것(2026-09-24 총검수).
 */
execFileSync(process.execPath, [join(repositoryRoot, "scripts/build-web-deployment.mjs"), "--qa"], {
  cwd: repositoryRoot,
  stdio: "inherit",
  windowsHide: true,
});

await runGroup(selected, {});

/*
 * 공유 런타임도 루트 Web/(공개 미리보기)이 아니라 검사용 빌드를 내보낸다. 미리보기 빌드는
 * /admin 을 빼므로 관리자 화면 QA 만 production 검사 빌드로 따로 띄운다(2026-09-25).
 */
const adminHostBased = hostBased.filter((name) => name.startsWith("admin-"));
const hostRuntimes = [
  [hostBased.filter((name) => !name.startsWith("admin-")), "qa-web"],
  [adminHostBased, "qa-web-production"],
];
for (const [names, webDirectory] of hostRuntimes) {
  if (names.length === 0) continue;
  /*
   * 이 부류는 자기 서버를 안 띄우고 `CLASSHUB_APP_ORIGIN` 으로 받는다. 하나만 띄워
   * 전부에게 물려준다 — 각자 띄우면 그만큼 컨테이너를 더 돌리게 된다.
   */
  const { startNormalSyntheticRuntime } = await import(
    pathToFileURL(join(browserQaDirectory, "lib", "normal-synthetic-runtime.mjs")).href
  );
  let runtime;
  try {
    runtime = await startNormalSyntheticRuntime({
      adminWebEnabled: webDirectory === "qa-web-production",
      port: 0,
      webRoot: join(repositoryRoot, ".local-runtime", webDirectory),
    });
    process.stdout.write(`\n공유 런타임 (${webDirectory}): ${runtime.appOrigin}\n`);
    /*
     * 이 부류는 순수 `.mjs`이고 TypeScript 런타임을 직접 불러오지 않는다. 불필요한
     * tsx 로더를 자식에 붙이면 Windows Edge의 CDP 기동이 시간초과되는 것을
     * 2026-09-04에 재현했다. TypeScript 하네스를 쓰는 자기 서버 부류만 로더를 유지한다.
     */
    await runGroup(names, { CLASSHUB_APP_ORIGIN: runtime.appOrigin }, { typescriptLoader: false });
  } finally {
    await runtime?.stop?.();
  }
}

/*
 * 재시도로 살아난 것은 게이트를 막지 않지만 **반드시 보이게** 남긴다. 여기 자주
 * 오르는 이름이 있으면 그건 "부하 탓"이 아니라 그 QA 자체의 문제일 수 있다.
 */
if (revived.length > 0) {
  process.stdout.write(
    `\n⚠️ 한 번 죽었다가 재시도로 살아난 ${revived.length}건 — 게이트는 막지 않았다.\n` +
      `   같은 이름이 반복해서 오르면 부하 탓이 아니라 그 QA 의 문제다(T-HUB-27).\n`,
  );
  for (const { hint, name } of revived) process.stdout.write(`   - ${name}: ${hint}\n`);
}

if (failures.length === 0) {
  process.stdout.write(`\n브라우저 QA ${total}개 전부 통과.\n`);
  process.exit(0);
}

process.stdout.write(`\n=== 두 번 다 실패한 ${failures.length}건 ===\n`);
for (const { hint, name } of failures) process.stdout.write(`- ${name}: ${hint}\n`);
process.stdout.write("\n=== 실패한 QA 의 전체 출력 ===\n");
for (const { name, output } of failures) {
  process.stdout.write(`\n--- ${name} ---\n${output}\n`);
}
process.exit(1);
