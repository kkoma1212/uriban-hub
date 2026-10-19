import { describe, expect, it } from "vitest";

import { isContentAudienceRequest } from "./content-audiences";

describe("content audience request guard", () => {
  it("accepts the all mode only without member ids", () => {
    expect(isContentAudienceRequest({ mode: "all" })).toBe(true);
    expect(isContentAudienceRequest({ member_ids: ["1"], mode: "all" })).toBe(false);
  });

  it("accepts selected mode with 1-60 positive-integer member ids", () => {
    expect(isContentAudienceRequest({ member_ids: ["1", "27"], mode: "selected" })).toBe(true);
    expect(isContentAudienceRequest({ member_ids: [], mode: "selected" })).toBe(false);
    expect(
      isContentAudienceRequest({
        member_ids: Array.from({ length: 61 }, (_, index) => String(index + 1)),
        mode: "selected",
      }),
    ).toBe(false);
    // 세션 저장소에서 복원되는 값이므로 위조된 형태를 걸러야 한다.
    expect(isContentAudienceRequest({ member_ids: ["0"], mode: "selected" })).toBe(false);
    expect(isContentAudienceRequest({ member_ids: ["01"], mode: "selected" })).toBe(false);
    expect(isContentAudienceRequest({ member_ids: [7], mode: "selected" })).toBe(false);
  });

  it("rejects non-object shapes", () => {
    expect(isContentAudienceRequest(null)).toBe(false);
    expect(isContentAudienceRequest(["all"])).toBe(false);
    expect(isContentAudienceRequest("all")).toBe(false);
    expect(isContentAudienceRequest({ mode: "everyone" })).toBe(false);
  });
});
