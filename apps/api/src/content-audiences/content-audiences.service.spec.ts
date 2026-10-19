import { describe, expect, it } from "vitest";

import { ContentAudiencesService, normalizeContentAudience } from "./content-audiences.service.js";
import {
  InvalidContentAudienceException,
  SelectedContentAudienceDisabledException,
} from "./content-audiences.errors.js";

describe("content audiences", () => {
  it("defaults to an all-student publication snapshot", () => {
    expect(normalizeContentAudience(undefined)).toEqual({
      memberIds: [],
      mode: "all",
      storedMode: "all_snapshot",
    });
  });

  it("deduplicates and numerically sorts selected member ids", () => {
    expect(
      normalizeContentAudience({
        member_ids: ["10", "2", "10", "1"],
        mode: "selected",
      }),
    ).toEqual({
      memberIds: ["1", "2", "10"],
      mode: "selected",
      storedMode: "selected_snapshot",
    });
  });

  it("rejects empty, out-of-range, and mode-inconsistent selections", () => {
    for (const audience of [
      { member_ids: [], mode: "selected" as const },
      { member_ids: ["9223372036854775808"], mode: "selected" as const },
      { member_ids: ["1"], mode: "all" as const },
    ]) {
      expect(() => normalizeContentAudience(audience)).toThrow(InvalidContentAudienceException);
    }
  });

  it("fails closed before any database query when selected authoring is disabled", async () => {
    const service = new ContentAudiencesService({
      get: () => false,
    } as never);

    await expect(
      service.resolveRecipientIds({} as never, "1", {
        memberIds: ["2"],
        mode: "selected",
        storedMode: "selected_snapshot",
      }),
    ).rejects.toBeInstanceOf(SelectedContentAudienceDisabledException);
  });
});
