import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPoll,
  deletePoll,
  getPoll,
  getPollParticipation,
  listPolls,
  voteInPoll,
} from "./polls";

const item = {
  ballot_visibility: "private",
  closes_at: "2026-07-31T03:00:00.000Z",
  created_at: "2026-07-30T03:00:00.000Z",
  description: "한 가지를 골라 주세요.",
  has_voted: false,
  id: "poll-17",
  my_option_id: null,
  options: [
    { id: "option-1", label: "첫 번째", position: 1, vote_count: null },
    { id: "option-2", label: "두 번째", position: 2, vote_count: null },
  ],
  results_policy: "after_vote",
  results_visible: false,
  row_version: "1",
  status: "open",
  title: "학급 운영 투표",
  total_vote_count: null,
} as const;

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...headers },
    status,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

describe("polls API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads scoped lists, detail ETags, and teacher participation", async () => {
    const participation = {
      ballot_visibility: "private",
      poll_id: "poll-17",
      total_students: 2,
      unvoted_count: 1,
      unvoted_students: [],
      voted_count: 1,
      voted_students: [],
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ items: [item], scope: "open", server_now: "2026-07-30T03:00:00Z" }),
      )
      .mockResolvedValueOnce(jsonResponse(item, 200, { ETag: '"server-etag"' }))
      .mockResolvedValueOnce(jsonResponse(participation));

    await expect(listPolls("open")).resolves.toMatchObject({ items: [item], scope: "open" });
    await expect(getPoll("poll/17")).resolves.toEqual({ etag: '"server-etag"', item });
    await expect(getPollParticipation("poll/17")).resolves.toEqual(participation);

    expect(requestUrl(fetchMock.mock.calls[0]?.[0] as RequestInfo)).toBe(
      "/api/v1/polls?scope=open",
    );
    expect(requestUrl(fetchMock.mock.calls[1]?.[0] as RequestInfo)).toBe("/api/v1/polls/poll%2F17");
    expect(requestUrl(fetchMock.mock.calls[2]?.[0] as RequestInfo)).toBe(
      "/api/v1/polls/poll%2F17/participation",
    );
  });

  it("creates with the exact body and caller idempotency key", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(item, 201, { ETag: '"1"' }));
    const request = {
      ballot_visibility: "teacher_visible" as const,
      closes_at: item.closes_at,
      description: item.description,
      options: item.options.map((option) => option.label),
      results_policy: "after_close" as const,
      title: item.title,
    };

    await expect(createPoll(request, "11111111-1111-4111-8111-111111111111")).resolves.toEqual({
      etag: '"1"',
      item,
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify(request));
    expect(headers.get("Idempotency-Key")).toBe("11111111-1111-4111-8111-111111111111");
    expect(headers.get("X-CSRF-Token")).toBe("csrf-value");
  });

  it("votes with one option and preserves the caller key", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    const votedItem = {
      ...item,
      has_voted: true,
      my_option_id: "option-2",
      options: item.options.map((option) => ({
        ...option,
        vote_count: option.id === "option-2" ? 1 : 0,
      })),
      results_visible: true,
      total_vote_count: 1,
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(votedItem, 201, { ETag: '"1"' }));

    await voteInPoll("poll-17", "option-2", "22222222-2222-4222-8222-222222222222");

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(requestUrl(fetchMock.mock.calls[0]?.[0] as RequestInfo)).toBe(
      "/api/v1/polls/poll-17/votes",
    );
    expect(init?.body).toBe(JSON.stringify({ option_id: "option-2" }));
    expect(headers.get("Idempotency-Key")).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("hard-deletes with the exact strong ETag", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await deletePoll("poll-17", '"1-from-server"');

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(init?.method).toBe("DELETE");
    expect(headers.get("If-Match")).toBe('"1-from-server"');
    expect(headers.get("X-CSRF-Token")).toBe("csrf-value");
  });
});
