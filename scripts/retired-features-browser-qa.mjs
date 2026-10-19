import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { URL } from "node:url";
import { launchIsolatedBrowser } from "../browser-qa/lib/wave1-browser-runtime.mjs";
import { openIsolatedPage } from "../browser-qa/lib/wave1-cdp.mjs";
import { capture, setViewport, waitFor } from "../browser-qa/lib/wave1-calendar-qa-support.mjs";

// API responses exist only inside disposable browser targets. No account login,
// cookie injection, real API forwarding, database connection, or backend assertion.
const argument = process.argv.slice(2);
assert.equal(argument.length, 1, "Expected --public-origin=https://host");
assert.ok(argument[0].startsWith("--public-origin="), "Expected public origin argument");
const publicUrl = new URL(argument[0].slice("--public-origin=".length));
assert.equal(publicUrl.protocol, "https:");
assert.equal(publicUrl.username + publicUrl.password + publicUrl.search + publicUrl.hash, "");
assert.equal(publicUrl.pathname, "/");
const publicOrigin = publicUrl.origin;
const directory = resolve(".local-backups/t-hub-64-retired-features-20260907");
const distDirectory = resolve("Web");
const retiredRoutes = ["/seating", "/seating/1", "/grouping", "/grouping/1", "/duty"];
const retiredApi = /^\/api\/v1\/(?:seat-draws|team-draws|duty-rosters)(?:\/|$)/u;
const retiredLink = /^\/(?:seating|grouping|duty)(?:\/|$)/u;
const retiredCopy =
  /자리\s*배치|모둠\s*배치|교실\s*배치|자리와\s*모둠|자리표|모둠표|내 자리|내 모둠|당번/u;
const legacyActions = [
  "MANAGE_SEAT_DRAWS",
  "VIEW_SEAT_DRAWS",
  "MANAGE_TEAM_DRAWS",
  "VIEW_TEAM_DRAWS",
  "MANAGE_DUTY_ROSTERS",
  "VIEW_DUTY_ROSTERS",
];
const serverToday = new Date(Date.now() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10);
const report = {
  status: "retired_features_browser_qa_failed",
  startedAt: new Date().toISOString(),
  apiMode: "browser_interception_only",
  realBackendVerified: false,
  realAccountLoginPerformed: false,
  realDatabaseMutationPerformed: false,
  legacyAllowedActions: legacyActions,
  origins: [],
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture(role) {
  const name = role === "teacher" ? "합성 선생님" : "합성 학생";
  const classId = "9007199255900001";
  const bootstrap = {
    account: { display_name: name, email_verified: true, is_active: true },
    allowed_actions: [
      "CHANGE_PASSWORD",
      "LOGOUT",
      "VIEW_CLASS",
      ...legacyActions,
      ...(role === "teacher"
        ? ["MANAGE_CLASS", "MANAGE_POLLS", "MANAGE_ELECTIONS"]
        : ["VOTE_IN_POLLS", "VOTE_IN_ELECTIONS"]),
    ],
    current_class: { id: classId, name: "합성 검증 1반", status: "active" },
    current_membership: {
      class_id: classId,
      display_name_in_class: name,
      id: role === "teacher" ? "9007199255900002" : "9007199255900003",
      role,
      status: "approved",
      student_number: role === "student" ? 1 : null,
    },
    destination: "HOME",
    last_membership_status: null,
    last_status_reason: null,
    server_today: serverToday,
    teacher_profile:
      role === "teacher" ? { status: "active", temporary_password_must_change: false } : null,
  };
  const election = {
    id: "9007199255900004",
    has_voted: false,
    participant_count: 0,
    opened_at: `${serverToday}T00:00:00.000Z`,
    published_at: null,
    status: "open",
    title: "합성 대표 선거",
  };
  return new Map([
    ["/api/v1/bootstrap", bootstrap],
    [
      "/api/v1/home",
      {
        attendance: { data: null, status: "empty" },
        meal: { data: null, status: "empty" },
        notices: { data: [], status: "empty" },
        pending_member_count: role === "teacher" ? 0 : null,
        polls: { data: [], status: "empty" },
        reminders: { data: [], status: "empty" },
        schedules: { data: [], status: "empty" },
        server_today: serverToday,
        supplies: { data: [], status: "empty" },
        teacher_followups: role === "teacher" ? { data: [], status: "empty" } : null,
      },
    ],
    [
      "/api/v1/polls?scope=open",
      {
        items: [
          {
            id: "9007199255900005",
            closes_at: `${serverToday}T14:59:59.000Z`,
            title: "합성 반 투표",
          },
        ],
        next_cursor: null,
        scope: "open",
        server_now: `${serverToday}T00:00:00.000Z`,
      },
    ],
    ...(role === "teacher"
      ? [["/api/v1/elections", { items: [election] }]]
      : [["/api/v1/elections/current", { item: election }]]),
  ]);
}

async function staticResponse(origin, path) {
  assert.ok(!path.startsWith("/api/"), "Host requests must remain static only");
  const response = await fetch(origin + path, {
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  assert.equal(response.status, 200, `Static HTTP status: ${path}`);
  return response;
}

async function verifyServedAssets(origin, result) {
  const html = await (await staticResponse(origin, "/login")).text();
  assert.match(html, /우리반 허브/u, "Application title");
  result.indexSha256 = digest(html);
  if (result.developmentAssets) {
    assert.match(html, /\/@vite\/client/u, "Local server must serve Vite development assets");
    result.distComparisonApplicable = false;
    return;
  }
  const builtHtml = await readFile(resolve(distDirectory, "index.html"), "utf8");
  assert.equal(digest(html), digest(builtHtml), "Public index must match the latest local build");
  result.distComparisonApplicable = true;
  result.assets = [];
  for (const path of new Set(
    [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/gu)].map((match) => match[1]),
  )) {
    assert.match(path, /^\/assets\/[a-zA-Z0-9._-]+\.(?:js|css)$/u);
    const bytes = Buffer.from(await (await staticResponse(origin, path)).arrayBuffer());
    const built = await readFile(resolve(distDirectory, "." + path));
    assert.equal(digest(bytes), digest(built), `Public asset must match build: ${path}`);
    result.assets.push({ path, sha256: digest(bytes) });
  }
  assert.ok(
    result.assets.some(({ path }) => path.endsWith(".js")),
    "Built script exists",
  );
  assert.ok(
    result.assets.some(({ path }) => path.endsWith(".css")),
    "Built stylesheet exists",
  );
}

async function interceptApi(page, origin, role) {
  const responses = fixture(role);
  const audit = { apiRequests: [], violations: [], runtimeExceptions: 0 };
  page.on("Runtime.exceptionThrown", () => {
    audit.runtimeExceptions += 1;
  });
  page.on("Fetch.requestPaused", async ({ requestId, request }) => {
    try {
      const url = new URL(request.url);
      const path = url.pathname + url.search;
      if (url.pathname.startsWith("/api/")) {
        audit.apiRequests.push({ method: request.method, path });
        if (url.origin === origin && request.method === "GET" && responses.has(path)) {
          await page.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [
              { name: "Content-Type", value: "application/json" },
              { name: "Cache-Control", value: "no-store" },
            ],
            body: Buffer.from(JSON.stringify(responses.get(path))).toString("base64"),
          });
          return;
        }
        audit.violations.push({ kind: "unexpected_api", method: request.method, path });
      } else if (url.origin === origin && ["GET", "HEAD"].includes(request.method)) {
        await page.send("Fetch.continueRequest", { requestId });
        return;
      } else {
        audit.violations.push({ kind: "blocked_external_or_mutation", method: request.method });
      }
      await page.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
    } catch {
      audit.violations.push({ kind: "interception_failure" });
      await page
        .send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
        .catch(() => undefined);
    }
  });
  await page.send("Fetch.enable", {
    patterns: [
      { requestStage: "Request", urlPattern: "http://*/*" },
      { requestStage: "Request", urlPattern: "https://*/*" },
    ],
  });
  return audit;
}

async function renderedState(page) {
  // Wait two rendered frames and a short settling interval for effect-started reads.
  await page.send("Runtime.evaluate", {
    awaitPromise: true,
    expression:
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200))))",
  });
  return page.evaluate(`({
    title: document.title, origin: location.origin, path: location.pathname,
    text: document.body.innerText,
    links: [...document.querySelectorAll('a[href]')].map(a => new URL(a.href).pathname),
    labels: [...document.querySelectorAll('[aria-label], [title], img[alt]')].map(e => [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('alt')].filter(Boolean).join(' ')).join(' '),
    resources: performance.getEntriesByType('resource').map(r => r.name),
    overflowX: document.documentElement.scrollWidth > innerWidth + 1
  })`);
}

function assertClean(state, origin, audit) {
  assert.equal(state.origin, origin);
  assert.match(state.title, /우리반 허브/u);
  assert.doesNotMatch(state.text + " " + state.labels, retiredCopy, "No retired feature copy");
  assert.deepEqual(
    state.links.filter((path) => retiredLink.test(path)),
    [],
    "No retired feature links",
  );
  assert.deepEqual(
    audit.apiRequests.filter(({ path }) => retiredApi.test(path)),
    [],
    "No retired feature API requests",
  );
  assert.deepEqual(audit.violations, [], "Only synthetic API reads and origin static reads");
  assert.equal(audit.runtimeExceptions, 0, "No browser runtime exception");
  assert.equal(state.overflowX, false, "No horizontal overflow");
}

async function verifyRole(browser, origin, result, role) {
  const viewport =
    role === "teacher"
      ? { width: 1440, height: 900, mobile: false, name: "desktop" }
      : { width: 390, height: 844, mobile: true, name: "mobile" };
  const page = await openIsolatedPage({ appOrigin: origin, cdpPort: browser.cdpPort });
  try {
    await Promise.all([
      page.send("Network.enable"),
      page.send("Page.enable"),
      page.send("Runtime.enable"),
    ]);
    await page.send("Network.setBypassServiceWorker", { bypass: true });
    await page.send("Network.setCacheDisabled", { cacheDisabled: true });
    const audit = await interceptApi(page, origin, role);
    for (const path of ["/home", "/activities"]) {
      const start = audit.apiRequests.length;
      await page.send("Page.navigate", { url: origin + path });
      await waitFor(
        page,
        path === "/home"
          ? `document.querySelector('[data-${role}-home]') !== null && document.body.innerText.includes('합성 검증 1반')`
          : `document.querySelectorAll('[data-activity-summary="ready"]').length === 2`,
        `${role} ${path}`,
        15_000,
      );
      // about:blank has no viewport meta tag; measure mobile only after app HTML loads.
      await setViewport(page, viewport);
      const state = await renderedState(page);
      assert.equal(state.path, path);
      assertClean(state, origin, audit);
      const requests = [
        ...new Set(audit.apiRequests.slice(start).map(({ path: requestPath }) => requestPath)),
      ].sort();
      assert.deepEqual(
        requests,
        path === "/home"
          ? ["/api/v1/bootstrap", "/api/v1/home"]
          : [
              "/api/v1/bootstrap",
              role === "teacher" ? "/api/v1/elections" : "/api/v1/elections/current",
              "/api/v1/polls?scope=open",
            ],
      );
      if (path === "/activities") {
        assert.match(state.text, /합성 반 투표/u);
        assert.match(state.text, /합성 대표 선거/u);
        assert.ok(state.links.includes("/polls") && state.links.includes("/elections"));
      }
      for (const asset of result.assets ?? [])
        assert.ok(
          state.resources.includes(origin + asset.path),
          `Browser loaded verified asset: ${asset.path}`,
        );
      result.states.push({
        role,
        viewport: viewport.name,
        path,
        apiRequests: requests,
        retiredApiRequests: 0,
        retiredCopyAndLinks: 0,
        verifiedBuildAssetsLoaded: !result.developmentAssets,
      });
      await capture(page, directory, `${result.name}-${role}-${path.slice(1)}.png`);
    }
    if (role === "teacher") {
      for (const path of retiredRoutes) {
        const start = audit.apiRequests.length;
        await page.send("Page.navigate", { url: origin + path });
        await waitFor(
          page,
          "document.querySelector('[data-not-found-page]') !== null",
          `wildcard ${path}`,
          15_000,
        );
        const state = await renderedState(page);
        assert.equal(state.path, path);
        assertClean(state, origin, audit);
        const notFound = await page.evaluate(
          `({ heading: document.querySelector('h1')?.textContent, alerts: document.querySelectorAll('[role="alert"]').length })`,
        );
        assert.equal(notFound.heading, "페이지를 찾을 수 없어요.");
        assert.equal(notFound.alerts, 0, "No extra retired-feature alert");
        assert.equal(audit.apiRequests.length, start, "Wildcard page makes no API request");
        result.directRoutes.push({
          path,
          existingNotFound: true,
          extraAlert: false,
          apiRequests: 0,
        });
      }
    }
    result.syntheticApiRequests += audit.apiRequests.length;
  } finally {
    await page.closeTarget();
  }
}

await mkdir(directory, { recursive: true });
try {
  for (const target of [
    { name: "local", origin: "http://localhost:5174", developmentAssets: true },
    { name: "public", origin: publicOrigin, developmentAssets: false },
  ]) {
    const result = {
      ...target,
      states: [],
      directRoutes: [],
      syntheticApiRequests: 0,
      browserClosed: false,
    };
    report.origins.push(result);
    await verifyServedAssets(target.origin, result);
    const browser = await launchIsolatedBrowser(target.origin);
    try {
      for (const role of ["teacher", "student"])
        await verifyRole(browser, target.origin, result, role);
    } finally {
      await browser.stop();
      result.browserClosed = true;
    }
    process.stdout.write(`${target.name}: 4 home/activity states + 5 wildcard routes passed\n`);
  }
  report.status = "retired_features_browser_qa_pass";
  report.checks = 18;
} catch (error) {
  report.failure = error instanceof Error ? error.message : "Unknown browser QA failure";
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await writeFile(
    resolve(directory, "browser-verification.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      status: report.status,
      checks: report.checks ?? 0,
      evidence: ".local-backups/t-hub-64-retired-features-20260907/browser-verification.json",
      ...(report.failure ? { failure: report.failure } : {}),
    }) + "\n",
  );
}
