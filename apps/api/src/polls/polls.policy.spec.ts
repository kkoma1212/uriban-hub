import { describe, expect, it } from "vitest";

import { shouldShowPollResults, withPollPolicyDefaults } from "./polls.policy.js";

describe("poll result visibility policy", () => {
  it.each([
    ["after_vote", "open", false, false],
    ["after_vote", "open", true, true],
    ["after_vote", "closed", false, true],
    ["after_close", "open", false, false],
    ["after_close", "open", true, false],
    ["after_close", "closed", false, true],
    ["teacher_only", "open", false, false],
    ["teacher_only", "open", true, false],
    ["teacher_only", "closed", true, false],
  ] as const)(
    "applies %s for a student in %s state with hasVoted=%s",
    (resultsPolicy, status, hasVoted, expected) => {
      expect(
        shouldShowPollResults({
          actorRole: "student",
          ballotVisibility: "teacher_visible",
          hasVoted,
          resultsPolicy,
          status,
        }),
      ).toBe(expected);
    },
  );

  it.each(["after_vote", "after_close", "teacher_only"] as const)(
    "always exposes %s aggregate results to the teacher",
    (resultsPolicy) => {
      expect(
        shouldShowPollResults({
          actorRole: "teacher",
          ballotVisibility: "teacher_visible",
          hasVoted: false,
          resultsPolicy,
          status: "open",
        }),
      ).toBe(true);
    },
  );

  describe.each(["teacher", "student"] as const)("private ballots for %s", (actorRole) => {
    it.each(["after_vote", "after_close", "teacher_only"] as const)(
      "hides open %s counts even after voting and retains closed audience rules",
      (resultsPolicy) => {
        for (const hasVoted of [false, true]) {
          expect(
            shouldShowPollResults({
              actorRole,
              ballotVisibility: "private",
              hasVoted,
              resultsPolicy,
              status: "open",
            }),
          ).toBe(false);
          expect(
            shouldShowPollResults({
              actorRole,
              ballotVisibility: "private",
              hasVoted,
              resultsPolicy,
              status: "closed",
            }),
          ).toBe(actorRole === "teacher" || resultsPolicy !== "teacher_only");
        }
      },
    );
  });

  it("backfills policy fields on legacy idempotency responses", () => {
    const legacy = {
      closes_at: "2026-08-03T00:00:00.000Z",
      created_at: "2026-08-02T00:00:00.000Z",
      description: null,
      has_voted: true,
      id: "1",
      my_option_id: "2",
      options: [{ id: "2", label: "Option", position: 1, vote_count: 1 }],
      results_visible: true,
      row_version: "1",
      status: "open" as const,
      title: "기존 응답",
      total_vote_count: 1,
    };

    expect(withPollPolicyDefaults(legacy, "private", "after_vote")).toMatchObject({
      ballot_visibility: "private",
      results_policy: "after_vote",
      results_visible: false,
      total_vote_count: null,
      has_voted: true,
      my_option_id: "2",
      options: [{ id: "2", vote_count: null }],
    });
    expect(legacy.options[0]!.vote_count).toBe(1);
    expect(
      withPollPolicyDefaults({ ...legacy, status: "closed" }, "private", "after_vote")
        .total_vote_count,
    ).toBe(1);
    expect(withPollPolicyDefaults(legacy, "teacher_visible", "after_vote").total_vote_count).toBe(
      1,
    );
  });
});
