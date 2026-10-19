/*
 * T-HUB-15 — 공지·준비물 내용 검색.
 *
 * 지키려는 것 셋.
 *  ① 제목과 본문 **둘 다**에서 찾는다(제목만 찾으면 "그때 그 준비물 뭐였지"를 못 푼다).
 *  ② 사용자가 넣은 `%` `_` 가 와일드카드로 새지 않는다 — `%` 한 글자로 전부가 걸리면
 *     검색이 아니라 목록이다.
 *  ③ 검색어와 커서가 어긋나면 거절한다. 안 막으면 다른 조건의 쪽이 이어 붙는다.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  app,
  createClassFixture,
  setupSuppliesHarness,
  teardownSuppliesHarness,
  type ClassFixture,
} from "./supplies-test-harness.js";

let fixture: ClassFixture;
let keySequence = 7000;

function nextIdempotencyKey(): string {
  keySequence += 1;
  return `70000000-0000-4000-8000-${String(keySequence).padStart(12, "0")}`;
}

async function createNotice(title: string, content: string): Promise<void> {
  const response = await app.inject({
    headers: { ...fixture.teacher.headers, "idempotency-key": nextIdempotencyKey() },
    method: "POST",
    payload: { content, is_important: false, title },
    url: "/api/v1/notices",
  });
  expect(response.statusCode).toBe(201);
}

async function searchNotices(term: string): Promise<string[]> {
  const response = await app.inject({
    headers: fixture.teacher.headers,
    method: "GET",
    url: `/api/v1/notices?q=${encodeURIComponent(term)}`,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { items: { title: string }[] }).items.map((item) => item.title);
}

beforeAll(async () => {
  await setupSuppliesHarness();
  fixture = await createClassFixture();

  await createNotice("현장학습 안내", "물병과 도시락을 챙겨 오세요.");
  await createNotice("독서록 제출", "이번 주까지 독서록을 내주세요.");
  await createNotice("100% 출석 축하", "우리 반이 해냈어요.");
}, 180_000);

afterAll(async () => {
  await teardownSuppliesHarness();
}, 120_000);

describe("content search", () => {
  it("finds a notice by its title", async () => {
    expect(await searchNotices("독서록")).toEqual(["독서록 제출"]);
  });

  it("finds a notice by words that only appear in the body", async () => {
    // 제목에는 "도시락"이 없다. 본문까지 찾지 않으면 이 공지는 영영 안 나온다.
    expect(await searchNotices("도시락")).toEqual(["현장학습 안내"]);
  });

  it("treats a percent sign as a letter, not a wildcard", async () => {
    /*
     * 이스케이프가 빠지면 `%` 하나가 전부를 건다. 그러면 검색이 아니라 목록이다.
     * 여기서는 제목에 진짜 `100%`가 있는 공지 하나만 나와야 한다.
     */
    expect(await searchNotices("%")).toEqual(["100% 출석 축하"]);
  });

  it("treats an underscore as a letter, not a single-character wildcard", async () => {
    // `_`가 와일드카드로 새면 아무 한 글자에나 걸려 여러 건이 나온다.
    expect(await searchNotices("_")).toEqual([]);
  });

  it("ignores a blank search term", async () => {
    const all = await searchNotices("   ");
    expect(all).toHaveLength(3);
  });

  it("refuses a cursor that belongs to a different search", async () => {
    const first = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: "/api/v1/notices?q=%EB%8F%85%EC%84%9C%EB%A1%9D",
    });
    const cursor = (first.json() as { next_cursor: string | null }).next_cursor;
    /*
     * 한 쪽으로 끝나면 커서가 null 이라 이 검사가 성립하지 않는다. 그때는 검색이
     * 없는 커서를 검색 요청에 붙여 거절되는지로 같은 계약을 확인한다.
     */
    const plain = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: "/api/v1/notices",
    });
    const plainCursor = (plain.json() as { next_cursor: string | null }).next_cursor;
    const borrowed = cursor ?? plainCursor;
    if (borrowed === null) return;
    const mismatched = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: `/api/v1/notices?q=%EB%8F%84%EC%8B%9C%EB%9D%BD&cursor=${encodeURIComponent(borrowed)}`,
    });
    expect(mismatched.statusCode).toBe(400);
  });

  it("caps the search term length", async () => {
    const tooLong = "가".repeat(51);
    const response = await app.inject({
      headers: fixture.teacher.headers,
      method: "GET",
      url: `/api/v1/notices?q=${encodeURIComponent(tooLong)}`,
    });
    expect(response.statusCode).toBe(400);
  });
});
