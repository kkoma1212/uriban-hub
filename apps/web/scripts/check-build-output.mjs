import { Console } from "node:console";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { argv, exit, stdout } from "node:process";
import { pathToFileURL, URL } from "node:url";
import { gzipSync } from "node:zlib";

const DIST_DIRECTORY = argv[2]
  ? pathToFileURL(resolve(argv[2]) + sep)
  : new URL("../../../Web/", import.meta.url);
const output = new Console(stdout);
const mode = argv[3] ?? "preview";
if (!["preview", "production"].includes(mode)) throw new Error("Unknown web build mode");
// 화면 묶음 종류(T-ADMIN-SPLIT, 2026-10-07): user = 학생·교사 화면 Web/, admin = 관리자 화면 AdminWeb/.
const target = argv[4] ?? "user";
if (!["user", "admin"].includes(target)) throw new Error("Unknown web build target");

// Baseline measured before route splitting on 2026-07-18. Budgets include roughly
// 10–16% regression headroom over the post-split build and are not network SLOs.
const BASELINE = {
  cssGzip: 26_730,
  cssRaw: 108_200,
  entryGzip: 188_650,
  entryRaw: 700_520,
  totalJavaScriptGzip: 198_070,
  totalJavaScriptRaw: 727_070,
};
const BUDGET = {
  /*
   * 2026-08-20 Hex 결정 — **gzip 을 주 기준으로 삼고, 천장 전부를 한 번에 다시 그었다.**
   * (T-HUB-32. 이 블록이 여유 폭의 유일한 근거다 — 항목마다 주석을 흩뿌리지 않는다.)
   *
   * 왜 다시 그었나: 2026-08-17 하루에 천장을 **세 번** 올렸다. 마지막은 **16 바이트**
   * 초과였다. 신호는 바이트가 아니라 **빈도**다 — 재 보니 천장 7개가 여유 3% 미만이고
   * 그중 하나는 **93 바이트(0.17%)**였다. 그 상태에서는 어떤 변경이든 하나를 건드리고,
   * 매번 "이번만 조금"으로 올리게 되어 게이트가 사후 승인 도장이 된다.
   *
   * 왜 gzip 이 주 기준인가: **사용자가 실제로 내려받는 것은 gzip 이다.** 그리고 실측이
   * 갈랐다 — 08-17에 걸린 셋은 **전부 raw 만** 넘었고 gzip 은 여유가 있었다. 우리가 가장
   * 자주 하는 변경이 Tailwind 클래스 추가인데, 같은 문자열이 반복되면 gzip 은 잘 압축하지만
   * raw 는 그대로 늘어난다. 즉 **raw 는 일상 변경에 과민하다.**
   *
   * 그래도 raw 를 남기는 이유: 폰이 **펼쳐서 읽고 실행하는 양**이라 CPU 부담을 나타낸다.
   * 다만 "구조가 통째로 폭증했을 때"만 울리도록 여유를 넓게 준다.
   *
   * 여유 폭: **gzip 10% · raw 25%**(실측 기준, 읽기 좋은 수로 위로 반올림).
   * ⚠️ 올리기만 한 것이 아니다 — 헐렁했던 7개는 **내려갔다**(예: 평가 화면 raw
   * 40,000 → 31,000). 재설정은 "다 올린다"가 아니라 "전부 같은 규칙으로 맞춘다"이다.
   *
   * ⚠️ **다음에 넘치면 이 줄을 옮기지 말 것.** 무엇이 늘었는지 먼저 재고, 정당한 증가면
   * 이 블록 전체를 같은 규칙으로 다시 긋는다(개별 천장 조정 금지 — 그게 이 과업이 막으려던 것).
   * ⚠️ 이 천장들은 네트워크 SLO 가 아니다. "느리다"는 근거가 나오면 천장이 아니라 내용물을
   * 줄인다(4기둥 — 최적화는 측정 근거 뒤). 폰 첫 화면 속도 측정은 T-HUB-26 의 열린 항목이다.
   *
   * 2026-08-21 재설정 — 모둠표 발표·인쇄를 넣자 모둠 상세가 천장을 161 바이트 넘었다.
   * 위 지시대로 개별 조정 대신 **블록 전체를 같은 규칙으로** 다시 그었고, 그 규칙이
   * `raw = 실측 × 1.25 를 1,000 단위 올림` · `gzip = 실측 × 1.1 을 500 단위 올림` 임을
   * 역산으로 확인했다 — **다른 화면 아홉의 천장이 08-20 값과 한 바이트도 다르지 않게
   * 재현됐다.** 그래서 실제로 움직인 것은 모둠 쪽 둘뿐이다.
   * 함께 고친 구멍: 새 발표·인쇄 청크가 "모둠 배치 기능" 계량에서 빠져 있었다(자리표는
   * seatDrawStudio 로 세고 있었다). 계량에 넣었으므로 천장 수치는 올라갔지만 **재는 범위가
   * 넓어진 것**이지 느슨해진 것이 아니다.
   */
  /*
   * 2026-08-29 T-HUB-59: self-hosted Noto Sans KR and the unified product shell
   * changed the measured bundle. Per P-007, every byte ceiling in this block was
   * rebased together from the final build: raw = ceil(measured * 1.25 / 1000) *
   * 1000; gzip = ceil(measured * 1.10 / 500) * 500. The chunk-count floor stays 20.
   */
  /*
   * 2026-09-17 P-007: BFCache privacy protection added 259 gzip bytes to the
   * preview build; the previous total headroom was 168 bytes. Rebase all byte
   * ceilings together from this measured build using the same 25% raw / 10%
   * gzip rule. Keep the chunk-count floor and all content checks unchanged.
   */
  /*
   * 2026-09-30 사용자 결정(A안): 관리자 화면은 교사·학생이 내려받지 않으므로 전체 JS 천장에서 빼고
   * 따로 잰다. 관리자 기능(첫 화면·목록·활동·운영 상태·세션) 추가로 운영 빌드 합계가 479,000 B를
   * 넘었는데(488,941 B), 그 초과분 전부가 관리자 파일(44,191 B)이었다. 교사·학생 천장은 그대로 두어
   * 그쪽 증가는 지금처럼 걸린다. 관리자 천장은 같은 규칙(gzip ×1.1 → 500 올림, raw ×1.25 → 1,000
   * 올림)으로 실측 44,191 / 172,707 B에서 그었다. 미리보기 빌드는 관리자 파일이 0이어야 한다(아래 검사).
   */
  /*
   * 2026-10-03 P-007: 학생 홈 오늘 정보 두 줄·소식 탭 기준 숫자·칠판 기본 높이(사용자 요청)로
   * 미리보기 전체 JS gzip이 천장을 324 B 넘었다(479,324 / 479,000). 9/17 재설정 뒤 반 대화·사진·
   * 소셜·생년월일 등으로 약 10% 늘어 여유를 다 쓴 상태였다. 규칙대로 개별 조정 없이 블록 전체를
   * 미리보기·정식 빌드 중 큰 실측에서 다시 그었다(raw ×1.25 → 1,000 올림, gzip ×1.1 → 500 올림).
   * 내려간 것: 초기 CSS(222,000/49,000 → 123,000/20,500), 학생 평가 raw(31,000 → 30,000).
   * 실측(raw/gzip): 전체 1,438,800/479,328 · 초기 369,826/114,675 · CSS 97,878/18,429 ·
   * 관리자 175,324/44,883 · 출결 42,531/11,274 · 평가 23,848/7,347 · 투표 16,656/5,841 ·
   * 투표 상세 19,205/5,980. 청크 수 하한 20은 그대로.
   */
  /*
   * 2026-10-07 사용자 결정(T-ADMIN-SPLIT): 관리자 화면이 별도 묶음(AdminWeb/)이 되면서, 전에는 교사·학생
   * 화면과 같이 쓰던 파일에 들어가 세지 않던 부품(QR 코드·아이콘·패스키)이 관리자 쪽에 함께 세어졌다.
   * 재는 범위가 바뀐 것이라 P-007 전체 재설정 대신 관리자 천장만 같은 규칙으로 새 묶음 실측
   * 212,194 / 57,024 B에서 다시 그었다. 교사·학생 천장은 그대로다.
   */
  adminJavaScriptGzip: 63_000,
  adminJavaScriptRaw: 266_000,
  attendanceRouteGzip: 12_500,
  attendanceRouteRaw: 54_000,
  cssGzip: 20_500,
  cssRaw: 123_000,
  entryGzip: 126_500,
  entryRaw: 463_000,
  minimumJavaScriptChunks: 20,
  pollDetailRouteGzip: 7_000,
  pollDetailRouteRaw: 25_000,
  pollsRouteGzip: 6_500,
  pollsRouteRaw: 21_000,
  studentAssessmentsRouteGzip: 8_500,
  studentAssessmentsRouteRaw: 30_000,
  totalJavaScriptGzip: 527_500,
  totalJavaScriptRaw: 1_799_000,
};
const FORBIDDEN_PRODUCTION_TEXT = [
  { label: "종료된 자리 화면", value: "/seating" },
  { label: "종료된 모둠 화면", value: "/grouping" },
  { label: "종료된 당번 화면", value: "/duty" },
  { label: "종료된 자리 API", value: "/api/v1/seat-draws" },
  { label: "종료된 모둠 API", value: "/api/v1/team-draws" },
  { label: "종료된 배치 임시저장 API", value: "/api/v1/layout-draft-autosaves" },
  { label: "종료된 배치 서식 API", value: "/api/v1/classroom-layout-templates" },
  { label: "로컬 테스트 관리자 API", value: "/api/v1/local-test-admin" },
  { label: "로컬 테스트 관리자 경로", value: "/local-test-admin" },
  { label: "로컬 테스트 관리자 문구", value: "로컬 테스트 관리" },
];

function bytes(value) {
  return `${(value / 1024).toFixed(2)} KiB`;
}

function percentChange(current, baseline) {
  const change = (current / baseline - 1) * 100;
  return `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;
}

async function assetSize(relativePath) {
  const path = new URL(relativePath.replace(/^\//u, ""), DIST_DIRECTORY);
  const source = await readFile(path);
  return { gzip: gzipSync(source).byteLength, raw: source.byteLength };
}

function fail(message) {
  throw new Error(`[build-output] ${message}`);
}

// 관리자 화면·관리자 API 코드가 든 청크(이용자 묶음에서는 없어야 하는 것과 같은 기준).
const isAdminAsset = ({ name, source }) =>
  /^admin[-.]/iu.test(name) || source.includes("/api/v1/admin");
const exists = (relativePath) =>
  stat(new URL(relativePath, DIST_DIRECTORY)).then(
    () => true,
    () => false,
  );

/** 관리자 묶음: 관리자 입구·관리자 화면만 있고, 이용자 화면과 앱 설치(PWA) 파일은 없어야 한다. */
async function checkAdminBundle() {
  const adminHtml = await readFile(new URL("admin/index.html", DIST_DIRECTORY), "utf8").catch(() =>
    fail("관리자 묶음에 admin/index.html이 없습니다."),
  );
  if (!/<script[^>]+src="\/assets\/[^"]+\.js"/u.test(adminHtml)) {
    fail("admin/index.html에서 초기 JavaScript entry를 찾지 못했습니다.");
  }
  for (const name of ["index.html", "sw.js", "registerSW.js", "manifest.webmanifest"]) {
    if (await exists(name)) fail(`관리자 묶음에 이용자 화면·앱 설치 파일 ${name}이 있습니다.`);
  }
  const names = (await readdir(new URL("assets/", DIST_DIRECTORY))).filter((name) =>
    name.endsWith(".js"),
  );
  const assets = await Promise.all(
    names.map(async (name) => ({
      name,
      size: await assetSize(`/assets/${name}`),
      source: await readFile(new URL(`assets/${name}`, DIST_DIRECTORY), "utf8"),
    })),
  );
  for (const page of ["admin-console-page-", "admin-login-page-", "admin-account-page-"]) {
    if (!names.some((name) => name.startsWith(page))) fail(`관리자 화면 청크 ${page}가 없습니다.`);
  }
  // 이용자 화면 대표 청크가 섞이면 두 묶음이 다시 엉킨 것이다.
  const userPages = [
    "login-page-",
    "bootstrap-page-",
    "home-page-",
    "attendance-page-",
    "polls-page-",
    "student-assessments-page-",
  ];
  const leaked = names.filter((name) => userPages.some((page) => name.startsWith(page)));
  if (leaked.length > 0) fail(`관리자 묶음에 이용자 화면 청크가 있습니다: ${leaked.join(", ")}`);
  for (const asset of assets) {
    for (const forbidden of FORBIDDEN_PRODUCTION_TEXT) {
      if (asset.source.includes(forbidden.value)) {
        fail(`${asset.name}에 ${forbidden.label}가 포함되었습니다.`);
      }
    }
  }
  const admin = assets.filter(isAdminAsset).reduce(
    (total, current) => ({
      gzip: total.gzip + current.size.gzip,
      raw: total.raw + current.size.raw,
    }),
    { gzip: 0, raw: 0 },
  );
  if (admin.raw > BUDGET.adminJavaScriptRaw || admin.gzip > BUDGET.adminJavaScriptGzip) {
    fail(
      `관리자 JS ${bytes(admin.raw)} raw / ${bytes(admin.gzip)} gzip이 예산 ${bytes(BUDGET.adminJavaScriptRaw)} / ${bytes(BUDGET.adminJavaScriptGzip)}를 넘었습니다.`,
    );
  }
  output.log(
    JSON.stringify(
      {
        target,
        mode,
        javascriptChunks: names.length,
        administratorChunks: names.filter((name) => /^admin[-.]/iu.test(name)).length,
        adminJavaScript: `${bytes(admin.raw)} raw / ${bytes(admin.gzip)} gzip`,
        userScreenChunks: 0,
        pwaFiles: 0,
      },
      null,
      2,
    ),
  );
}

if (target === "admin") {
  await checkAdminBundle();
  exit(0);
}

const indexHtml = await readFile(new URL("index.html", DIST_DIRECTORY), "utf8");
const entryMatch = indexHtml.match(/<script[^>]+src="([^"]+\.js)"/u);
if (entryMatch === null) fail("index.html에서 초기 JavaScript entry를 찾지 못했습니다.");

const stylesheetPaths = [...indexHtml.matchAll(/<link[^>]+href="([^"]+\.css)"/gu)].map(
  (match) => match[1],
);
if (stylesheetPaths.length === 0) fail("index.html에서 초기 CSS를 찾지 못했습니다.");

const entry = await assetSize(entryMatch[1]);
const stylesheetSizes = await Promise.all(stylesheetPaths.map(assetSize));
const css = stylesheetSizes.reduce(
  (total, current) => ({ gzip: total.gzip + current.gzip, raw: total.raw + current.raw }),
  { gzip: 0, raw: 0 },
);

const assetsDirectory = new URL("assets/", DIST_DIRECTORY);
const assetFiles = await readdir(assetsDirectory);
const javascriptChunks = assetFiles.filter((name) => name.endsWith(".js"));
const javascriptAssets = await Promise.all(
  javascriptChunks.map(async (name) => ({
    name,
    size: await assetSize(`/assets/${name}`),
    source: await readFile(new URL(`assets/${name}`, DIST_DIRECTORY), "utf8"),
  })),
);
const sumSizes = (assets) =>
  assets.reduce(
    (total, current) => ({
      gzip: total.gzip + current.size.gzip,
      raw: total.raw + current.size.raw,
    }),
    { gzip: 0, raw: 0 },
  );
const adminJavaScript = sumSizes(javascriptAssets.filter(isAdminAsset));
// 전체 JS = 교사·학생이 받을 수 있는 청크(관리자 청크 제외).
const totalJavaScript = javascriptAssets
  .filter((asset) => !isAdminAsset(asset))
  .reduce(
    (total, current) => ({
      gzip: total.gzip + current.size.gzip,
      raw: total.raw + current.size.raw,
    }),
    { gzip: 0, raw: 0 },
  );
const attendanceAssets = javascriptAssets.filter((asset) =>
  asset.name.startsWith("attendance-page-"),
);
const studentAssessmentsAssets = javascriptAssets.filter((asset) =>
  asset.name.startsWith("student-assessments-page-"),
);
const pollsAssets = javascriptAssets.filter((asset) => asset.name.startsWith("polls-page-"));
const pollDetailAssets = javascriptAssets.filter((asset) =>
  asset.name.startsWith("poll-detail-page-"),
);
const retiredToolAssets = javascriptAssets.filter((asset) =>
  [
    "seating-",
    "grouping-",
    "duty-",
    "seat-draw",
    "team-draw",
    "seat-grid-",
    "team-grid-",
    "classroom-layout-",
    "layout-draft-autosave",
  ].some((prefix) => asset.name.startsWith(prefix)),
);
const registerScriptPath = new URL("registerSW.js", DIST_DIRECTORY);
const registerScriptExists = await stat(registerScriptPath).then(
  () => true,
  () => false,
);
const serviceWorker = await readFile(new URL("sw.js", DIST_DIRECTORY), "utf8");
// 이용자 묶음은 미리보기·정식 모두 관리자 코드가 0이어야 한다(관리자 화면은 AdminWeb/ 별도 묶음).
if (javascriptAssets.some(isAdminAsset)) {
  fail("이용자 화면 묶음에 관리자 화면 또는 API 코드가 포함됐습니다.");
}
if (/\burl:\s*["']\/?assets\/admin[-.]/iu.test(serviceWorker)) {
  fail("이용자 화면 precache에 관리자 파일이 포함됐습니다.");
}
if (!serviceWorker.includes("/^\\/admin(?:\\/|%2f|$)/iu")) {
  fail("이용자 화면 navigation fallback에서 관리자 경로를 제외해야 합니다.");
}
const manifest = JSON.parse(
  await readFile(new URL("manifest.webmanifest", DIST_DIRECTORY), "utf8"),
);

if (entry.raw > BUDGET.entryRaw) {
  fail(`초기 JS raw ${bytes(entry.raw)}가 예산 ${bytes(BUDGET.entryRaw)}를 넘었습니다.`);
}
if (entry.gzip > BUDGET.entryGzip) {
  fail(`초기 JS gzip ${bytes(entry.gzip)}가 예산 ${bytes(BUDGET.entryGzip)}를 넘었습니다.`);
}
if (
  totalJavaScript.raw > BUDGET.totalJavaScriptRaw ||
  totalJavaScript.gzip > BUDGET.totalJavaScriptGzip
) {
  fail(
    `전체 JS ${bytes(totalJavaScript.raw)} raw / ${bytes(totalJavaScript.gzip)} gzip이 예산 ${bytes(BUDGET.totalJavaScriptRaw)} / ${bytes(BUDGET.totalJavaScriptGzip)}를 넘었습니다.`,
  );
}
if (css.raw > BUDGET.cssRaw || css.gzip > BUDGET.cssGzip) {
  fail(
    `초기 CSS ${bytes(css.raw)} raw / ${bytes(css.gzip)} gzip이 예산 ${bytes(BUDGET.cssRaw)} / ${bytes(BUDGET.cssGzip)}를 넘었습니다.`,
  );
}
if (javascriptChunks.length < BUDGET.minimumJavaScriptChunks) {
  fail(
    `JavaScript 청크가 ${javascriptChunks.length}개뿐입니다. 화면 단위 지연 로드가 유지되는지 확인하세요.`,
  );
}
if (attendanceAssets.length !== 1) {
  fail(
    `오늘 출결 알림 화면 청크를 정확히 1개 찾아야 하지만 ${attendanceAssets.length}개를 찾았습니다.`,
  );
}
if (studentAssessmentsAssets.length !== 1) {
  fail(
    `학생 평가 화면 청크를 정확히 1개 찾아야 하지만 ${studentAssessmentsAssets.length}개를 찾았습니다.`,
  );
}
if (pollsAssets.length !== 1 || pollDetailAssets.length !== 1) {
  fail(
    `투표 목록·상세 화면 청크를 각각 정확히 1개 찾아야 하지만 ${pollsAssets.length}개 / ${pollDetailAssets.length}개를 찾았습니다.`,
  );
}
if (retiredToolAssets.length !== 0) {
  fail("종료된 자리·모둠·당번 기능 청크가 제품 빌드에 포함되었습니다.");
}
const attendanceRoute = attendanceAssets[0];
if (
  attendanceRoute.size.raw > BUDGET.attendanceRouteRaw ||
  attendanceRoute.size.gzip > BUDGET.attendanceRouteGzip
) {
  fail(
    `오늘 출결 알림 화면 JS ${bytes(attendanceRoute.size.raw)} raw / ${bytes(attendanceRoute.size.gzip)} gzip이 예산 ${bytes(BUDGET.attendanceRouteRaw)} / ${bytes(BUDGET.attendanceRouteGzip)}를 넘었습니다.`,
  );
}
const studentAssessmentsRoute = studentAssessmentsAssets[0];
if (
  studentAssessmentsRoute.size.raw > BUDGET.studentAssessmentsRouteRaw ||
  studentAssessmentsRoute.size.gzip > BUDGET.studentAssessmentsRouteGzip
) {
  fail(
    `학생 평가 화면 JS ${bytes(studentAssessmentsRoute.size.raw)} raw / ${bytes(studentAssessmentsRoute.size.gzip)} gzip이 예산 ${bytes(BUDGET.studentAssessmentsRouteRaw)} / ${bytes(BUDGET.studentAssessmentsRouteGzip)}를 넘었습니다.`,
  );
}
const pollsRoute = pollsAssets[0];
if (pollsRoute.size.raw > BUDGET.pollsRouteRaw || pollsRoute.size.gzip > BUDGET.pollsRouteGzip) {
  fail(
    `투표 목록 화면 JS ${bytes(pollsRoute.size.raw)} raw / ${bytes(pollsRoute.size.gzip)} gzip이 예산 ${bytes(BUDGET.pollsRouteRaw)} / ${bytes(BUDGET.pollsRouteGzip)}를 넘었습니다.`,
  );
}
const pollDetailRoute = pollDetailAssets[0];
if (
  pollDetailRoute.size.raw > BUDGET.pollDetailRouteRaw ||
  pollDetailRoute.size.gzip > BUDGET.pollDetailRouteGzip
) {
  fail(
    `투표 상세 화면 JS ${bytes(pollDetailRoute.size.raw)} raw / ${bytes(pollDetailRoute.size.gzip)} gzip이 예산 ${bytes(BUDGET.pollDetailRouteRaw)} / ${bytes(BUDGET.pollDetailRouteGzip)}를 넘었습니다.`,
  );
}
for (const asset of javascriptAssets) {
  for (const forbidden of FORBIDDEN_PRODUCTION_TEXT) {
    if (asset.source.includes(forbidden.value)) {
      fail(`${asset.name}에 ${forbidden.label}가 포함되었습니다.`);
    }
  }
}
if (registerScriptExists) {
  fail("자동 registerSW.js가 생성됐습니다. 수동 업데이트 흐름과 중복 등록될 수 있습니다.");
}
if (/\burl:\s*["']\/api(?:\/|["'])/u.test(serviceWorker)) {
  fail("서비스 워커 precache에 API 경로가 포함됐습니다.");
}
if (!serviceWorker.includes("%2f|$)/iu")) {
  fail("서비스 워커 navigation fallback이 encoded API 경로를 제외하지 않습니다.");
}
if (manifest.id !== "/" || manifest.scope !== "/" || manifest.start_url !== "/bootstrap") {
  fail("manifest의 id·scope·start_url이 세션 bootstrap 진입 계약과 다릅니다.");
}
// 2026-09-23 웹 푸시·홈 화면 설치를 위해 아이콘을 허용한다. 대신 정해진 세 개만,
// 실제 파일과 선언 크기가 일치할 때만 통과시킨다(검증되지 않은 아이콘 차단 의도 유지).
const EXPECTED_ICONS = [
  "/icons/icon-192.png|192x192|any",
  "/icons/icon-512.png|512x512|any",
  "/icons/icon-maskable-512.png|512x512|maskable",
];
const declaredIcons = (manifest.icons ?? []).map(
  (icon) => `${icon.src}|${icon.sizes}|${icon.purpose ?? "any"}`,
);
if (JSON.stringify(declaredIcons) !== JSON.stringify(EXPECTED_ICONS)) {
  fail("manifest 아이콘이 검증된 세 개(192·512·maskable 512)와 다릅니다.");
}
for (const icon of manifest.icons ?? []) {
  const png = await readFile(new URL(icon.src.slice(1), DIST_DIRECTORY)).catch(() => null);
  const isPng = png !== null && png.subarray(1, 4).toString("ascii") === "PNG";
  const size = isPng ? `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}` : "";
  if (!isPng || size !== icon.sizes) {
    fail(
      `manifest 아이콘 ${icon.src}이 없거나 실제 크기(${size || "PNG 아님"})가 선언과 다릅니다.`,
    );
  }
}
if (!/importScripts\(\s*["']push-sw\.js["']\s*\)/u.test(serviceWorker)) {
  fail("서비스 워커가 웹 푸시 수신 처리(push-sw.js)를 불러오지 않습니다.");
}

output.log(
  JSON.stringify(
    {
      baseline: {
        css: `${bytes(BASELINE.cssRaw)} raw / ${bytes(BASELINE.cssGzip)} gzip`,
        entry: `${bytes(BASELINE.entryRaw)} raw / ${bytes(BASELINE.entryGzip)} gzip`,
        totalJavaScript: `${bytes(BASELINE.totalJavaScriptRaw)} raw / ${bytes(BASELINE.totalJavaScriptGzip)} gzip`,
      },
      current: {
        target,
        mode,
        administratorChunks: javascriptChunks.filter((name) => /^admin[-.]/iu.test(name)).length,
        attendanceRoute: `${attendanceRoute.name} · ${bytes(attendanceRoute.size.raw)} raw / ${bytes(attendanceRoute.size.gzip)} gzip`,
        css: `${bytes(css.raw)} raw / ${bytes(css.gzip)} gzip`,
        entry: `${bytes(entry.raw)} raw / ${bytes(entry.gzip)} gzip`,
        entryFile: entryMatch[1],
        javascriptChunks: javascriptChunks.length,
        retiredToolChunks: retiredToolAssets.length,
        pollDetailRoute: `${pollDetailRoute.name} · ${bytes(pollDetailRoute.size.raw)} raw / ${bytes(pollDetailRoute.size.gzip)} gzip`,
        pollsRoute: `${pollsRoute.name} · ${bytes(pollsRoute.size.raw)} raw / ${bytes(pollsRoute.size.gzip)} gzip`,
        studentAssessmentsRoute: `${studentAssessmentsRoute.name} · ${bytes(studentAssessmentsRoute.size.raw)} raw / ${bytes(studentAssessmentsRoute.size.gzip)} gzip`,
        totalJavaScript: `${bytes(totalJavaScript.raw)} raw / ${bytes(totalJavaScript.gzip)} gzip`,
        adminJavaScript: `${bytes(adminJavaScript.raw)} raw / ${bytes(adminJavaScript.gzip)} gzip`,
      },
      change: {
        entryGzip: percentChange(entry.gzip, BASELINE.entryGzip),
        entryRaw: percentChange(entry.raw, BASELINE.entryRaw),
        totalJavaScriptGzip: percentChange(totalJavaScript.gzip, BASELINE.totalJavaScriptGzip),
        totalJavaScriptRaw: percentChange(totalJavaScript.raw, BASELINE.totalJavaScriptRaw),
      },
      pwa: {
        apiPrecached: false,
        automaticRegisterScript: false,
        manifest: { id: manifest.id, scope: manifest.scope, startUrl: manifest.start_url },
        manifestIcons: declaredIcons,
        pushWorkerImported: true,
      },
    },
    null,
    2,
  ),
);
