import { describe, expect, it } from "vitest";

import {
  categoryCreatedNotice,
  checkActionLabel,
  checkStateLabel,
  uncheckedNounLabel,
} from "./supply-format";

/*
 * 준비물은 "챙기는" 것이고 숙제는 "하는" 것이다(2026-08-10 Hex 결정). 같은 기능이
 * 종류만 다르므로 상태 값은 그대로 두고 화면 말만 가른다.
 */
describe("supply check wording", () => {
  it("keeps the supply wording for supplies", () => {
    expect(checkStateLabel("checked", "general")).toBe("챙김");
    expect(checkStateLabel("unchecked", "general")).toBe("미챙김");
    expect(checkActionLabel("general")).toBe("챙겼어요");
    expect(uncheckedNounLabel("general")).toBe("미챙김");
  });

  it("says done rather than packed for homework", () => {
    expect(checkStateLabel("checked", "homework")).toBe("완료");
    expect(checkStateLabel("unchecked", "homework")).toBe("미완료");
    expect(checkActionLabel("homework")).toBe("다 했어요");
    expect(uncheckedNounLabel("homework")).toBe("미완료");
  });

  /*
   * 종류를 모르는 자리(예전 응답, 종류가 없던 초안)는 지금까지 쓰던 준비물 말로
   * 떨어져야 한다 — 빈칸이나 오류가 아니라.
   */
  it("falls back to the supply wording when the category is unknown", () => {
    expect(checkStateLabel("checked")).toBe("챙김");
    expect(checkActionLabel()).toBe("챙겼어요");
  });

  it("keeps the re-confirm wording the same for both", () => {
    expect(checkStateLabel("modified_unconfirmed", "general")).toBe("수정 후 재확인 필요");
    expect(checkStateLabel("modified_unconfirmed", "homework")).toBe("수정 후 재확인 필요");
  });
});

/*
 * 등록을 마쳤다는 알림은 **종류를 따라야** 한다. 숙제를 올리고 "준비물을 등록했어요"가
 * 뜨면 종류를 고른 보람이 없다(2026-08-22 Hex 검수에서 드러난 자리).
 *
 * 그리고 조사를 함께 잰다 — 이름만 갈아 끼우면 "숙제을"이 된다. 이 저장소가 이미 한 번
 * 겪은 모양이라 문장째로 만들었고, 여기서 못박아 둔다.
 */
describe("supply create notice", () => {
  it("names what was actually registered", () => {
    expect(categoryCreatedNotice("general")).toBe("준비물을 등록했어요.");
    expect(categoryCreatedNotice("homework")).toBe("숙제를 등록했어요.");
  });

  it("attaches the particle that matches the noun", () => {
    expect(categoryCreatedNotice("homework")).not.toContain("숙제을");
  });

  it("falls back to the supply wording when the category is unknown", () => {
    expect(categoryCreatedNotice()).toBe("준비물을 등록했어요.");
  });
});
