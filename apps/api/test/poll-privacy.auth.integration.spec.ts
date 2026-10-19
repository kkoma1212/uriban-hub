import type { JsonObject } from "@classhub/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  PollBallotVisibility,
  PollItem,
  PollListResult,
  PollParticipationResult,
  PollResultsPolicy,
} from "../src/polls/polls.types.js";
import {
  app,
  createClassFixture,
  database,
  setupPollsHarness,
  teardownSuppliesHarness,
  type ClassFixture,
} from "./supplies-test-harness.js";

let fixture: ClassFixture;
beforeAll(setupPollsHarness, 120_000);
beforeEach(async () => {
  fixture = await createClassFixture();
});
afterAll(teardownSuppliesHarness, 120_000);

function hidden(item: PollItem) {
  expect(item).toMatchObject({ status: "open", results_visible: false, total_vote_count: null });
  expect(item.options.map((option) => option.vote_count)).toEqual([null, null]);
}
async function create(
  policy: PollResultsPolicy,
  visibility: PollBallotVisibility = "private",
  key = randomUUID(),
) {
  const payload = {
    ballot_visibility: visibility,
    results_policy: policy,
    closes_at: new Date(Date.now() + 3600_000).toISOString(),
    title: "Synthetic privacy check",
    options: ["Blue", "Purple"],
  };
  const request = {
    method: "POST" as const,
    url: "/api/v1/polls",
    headers: { ...fixture.teacher.headers, "idempotency-key": key },
    payload,
  };
  const response = await app.inject(request);
  expect(response.statusCode, response.body).toBe(201);
  return { item: response.json() as PollItem, request, key };
}
async function vote(item: PollItem, student = 0, option = 0, key = randomUUID()) {
  const request = {
    method: "POST" as const,
    url: "/api/v1/polls/" + item.id + "/votes",
    headers: { ...fixture.students[student]!.headers, "idempotency-key": key },
    payload: { option_id: item.options[option]!.id },
  };
  const response = await app.inject(request);
  expect(response.statusCode, response.body).toBe(201);
  return { item: response.json() as PollItem, request, key };
}
async function views(item: PollItem, headers: Record<string, string>) {
  const detail = await app.inject({ method: "GET", url: "/api/v1/polls/" + item.id, headers });
  const list = await app.inject({ method: "GET", url: "/api/v1/polls?scope=open", headers });
  expect(detail.statusCode).toBe(200);
  expect(list.statusCode).toBe(200);
  return [
    detail.json() as PollItem,
    (list.json() as PollListResult).items.find((row) => row.id === item.id)!,
  ];
}

describe.sequential("private poll live aggregate boundaries", () => {
  it.each(["after_vote", "after_close", "teacher_only"] as const)(
    "prevents one-vote differencing across create, vote, replay, list and detail for %s",
    async (policy) => {
      const created = await create(policy);
      hidden(created.item);
      const first = await vote(created.item);
      hidden(first.item);
      expect(first.item).toMatchObject({
        has_voted: true,
        my_option_id: created.item.options[0]!.id,
      });
      for (const actor of [fixture.teacher, fixture.students[0], fixture.students[2]]) {
        for (const item of await views(created.item, actor.headers)) hidden(item);
      }
      hidden((await vote(created.item, 1, 1)).item);
      for (const actor of [fixture.teacher, fixture.students[0], fixture.students[2]]) {
        for (const item of await views(created.item, actor.headers)) hidden(item);
      }
      const replay = await app.inject(first.request);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.item);
      const participation = await app.inject({
        method: "GET",
        url: "/api/v1/polls/" + created.item.id + "/participation",
        headers: fixture.teacher.headers,
      });
      expect(participation.statusCode).toBe(200);
      const people = participation.json() as PollParticipationResult;
      expect(people.voted_count).toBe(2);
      expect(people.voted_students).toHaveLength(2);
      expect(participation.body).not.toContain("selected_option");
      const closed = await app.inject({
        method: "POST",
        url: "/api/v1/polls/" + created.item.id + "/close",
        headers: { ...fixture.teacher.headers, "if-match": '"' + created.item.row_version + '"' },
      });
      expect(closed.statusCode).toBe(200);
      expect(closed.json()).toMatchObject({
        status: "closed",
        results_visible: true,
        total_vote_count: 2,
      });
      const studentClosed = await app.inject({
        method: "GET",
        url: "/api/v1/polls/" + created.item.id,
        headers: fixture.students[2].headers,
      });
      expect(studentClosed.json()).toMatchObject({
        status: "closed",
        results_visible: policy !== "teacher_only",
        total_vote_count: policy === "teacher_only" ? null : 2,
      });
    },
  );

  it.each(["after_vote", "after_close", "teacher_only"] as const)(
    "preserves named poll live disclosure under %s",
    async (policy) => {
      const { item } = await create(policy, "teacher_visible");
      expect(item).toMatchObject({ results_visible: true, total_vote_count: 0 });
      const submitted = await vote(item);
      expect(submitted.item).toMatchObject({
        results_visible: policy === "after_vote",
        total_vote_count: policy === "after_vote" ? 1 : null,
      });
      for (const result of await views(item, fixture.teacher.headers)) {
        expect(result).toMatchObject({ results_visible: true, total_vote_count: 1 });
        expect(result.options.map((option) => option.vote_count)).toEqual([1, 0]);
      }
    },
  );

  it.each(["create", "vote"] as const)(
    "redacts old stored %s responses without changing the idempotency key or adding a ballot",
    async (kind) => {
      const created = await create("after_vote");
      const submitted = await vote(created.item);
      const original = kind === "create" ? created : submitted;
      const legacy = { ...original.item } as Partial<PollItem>;
      delete legacy.ballot_visibility;
      delete legacy.results_policy;
      delete legacy.closed_at;
      legacy.results_visible = true;
      legacy.total_vote_count = 1;
      legacy.options = original.item.options.map((option, index) => ({
        ...option,
        vote_count: index === 0 ? 1 : 0,
      }));
      const changed = await database
        .updateTable("api_idempotency_keys")
        .set({ response_body_json: legacy as unknown as JsonObject })
        .where("idempotency_key", "=", original.key)
        .executeTakeFirstOrThrow();
      expect(changed.numUpdatedRows).toBe(1n);
      const replay = await app.inject(original.request);
      expect(replay.statusCode, replay.body).toBe(201);
      hidden(replay.json() as PollItem);
      expect(replay.json()).toMatchObject({
        id: original.item.id,
        ballot_visibility: "private",
        results_policy: "after_vote",
        my_option_id: original.item.my_option_id,
      });
      const votes = await database
        .selectFrom("poll_votes")
        .select("id")
        .where("poll_id", "=", original.item.id)
        .execute();
      expect(votes).toHaveLength(1);
    },
  );
});
