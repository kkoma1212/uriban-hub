import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { launchIsolatedBrowser } from "../browser-qa/lib/wave1-browser-runtime.mjs";
import { openIsolatedPage } from "../browser-qa/lib/wave1-cdp.mjs";
import { capture, setViewport, waitFor } from "../browser-qa/lib/wave1-calendar-qa-support.mjs";
import { PREVIEW_ORIGIN_PATTERN } from "./phone-preview-environment.mjs";

const origin = process.argv[2];
assert.match(origin, PREVIEW_ORIGIN_PATTERN);
const directory = resolve(".local-runtime/preview-api");
const report = {
  origin,
  verifiedAt: new Date().toISOString(),
  http: [],
  assets: [],
  browser: [],
  passed: false,
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function request(path, expected, options = {}) {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(20_000), ...options });
  assert.equal(response.status, expected, path);
  report.http.push({ path, method: options.method ?? "GET", status: response.status });
  return response;
}
let browser;
let page;
try {
  assert.deepEqual(await (await request("/healthz", 200)).json(), { status: "ok" });
  assert.deepEqual(await (await request("/readyz", 200)).json(), { status: "ready" });
  const html = await (await request("/login", 200)).text();
  assert.match(html, /우리반 허브/u);
  const localHtml = await readFile("Web/index.html", "utf8");
  assert.equal(html, localHtml);
  const paths = [
    ...new Set(
      [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/gu)].map((m) => m[1]),
    ),
  ];
  assert.ok(paths.length >= 2);
  for (const path of paths) {
    const served = Buffer.from(await (await request(path, 200)).arrayBuffer());
    const local = await readFile(resolve("Web", "." + path));
    assert.equal(digest(served), digest(local));
    report.assets.push({ path, sha256: digest(served) });
  }
  const unauthorized = await (await request("/api/v1/bootstrap", 401)).json();
  assert.ok(unauthorized.error?.code);
  await request("/api/v1/auth/login", 400, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: "{}",
  });
  await request("/api/v1/auth/login", 403, {
    method: "POST",
    headers: { origin: "https://untrusted.example.invalid", "content-type": "application/json" },
    body: "{}",
  });
  browser = await launchIsolatedBrowser(origin);
  page = await openIsolatedPage({ appOrigin: origin, cdpPort: browser.cdpPort });
  await Promise.all([
    page.send("Network.enable"),
    page.send("Page.enable"),
    page.send("Runtime.enable"),
    page.send("Network.setBypassServiceWorker", { bypass: true }),
  ]);
  const exceptions = [];
  page.on("Runtime.exceptionThrown", ({ exceptionDetails }) =>
    exceptions.push(exceptionDetails?.text),
  );
  for (const viewport of [
    { width: 1440, height: 900, mobile: false, name: "desktop" },
    { width: 390, height: 844, mobile: true, name: "phone" },
  ]) {
    await setViewport(page, viewport);
    await page.send("Page.navigate", { url: origin + "/login" });
    await waitFor(
      page,
      `document.querySelector('#login-email') !== null && document.querySelector('#login-password') !== null`,
      "public login",
      30_000,
    );
    const state = await page.evaluate(
      `({ title: document.title, origin: location.origin, email: !!document.querySelector('#login-email'), password: !!document.querySelector('#login-password'), assets: performance.getEntriesByType('resource').map(r => r.name).filter(n => /\\.(js|css)(\\?|$)/.test(n)), overflowX: document.documentElement.scrollWidth > innerWidth + 1 })`,
    );
    assert.match(state.title, /우리반 허브/u);
    assert.equal(state.origin, origin);
    assert.equal(state.overflowX, false);
    for (const { path } of report.assets)
      assert.ok(state.assets.includes(origin + path), "browser loaded " + path);
    report.browser.push({ viewport: viewport.name, ...state });
    await capture(page, directory, viewport.name + ".png");
  }
  assert.deepEqual(exceptions, []);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (page) await page.closeTarget().catch(() => undefined);
  if (browser) await browser.stop();
  await writeFile(
    resolve(directory, "public-verification.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
