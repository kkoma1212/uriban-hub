import type { SupplyCategory, SupplyCheckState } from "../../api/supplies";

import { formatKstCalendarDate } from "../../lib/kst-format";

export function formatSupplyDate(value: string): string {
  return formatKstCalendarDate(value);
}

/*
 * 준비물은 "챙기는" 것이고 숙제는 "하는" 것이다. 같은 기능이 종류만 다르므로
 * 상태 값은 그대로 두고 화면에 보이는 말만 가른다. 종류를 모르는 자리(예전 응답,
 * 종류가 없던 초안)는 준비물 말로 떨어진다 — 지금까지 쓰던 말이라 안전한 기본값이다.
 */
const CHECK_STATE_LABELS: Record<SupplyCategory, Record<SupplyCheckState, string>> = {
  general: {
    checked: "챙김",
    modified_unconfirmed: "수정 후 재확인 필요",
    unchecked: "미챙김",
  },
  homework: {
    checked: "완료",
    modified_unconfirmed: "수정 후 재확인 필요",
    unchecked: "미완료",
  },
};

export function checkStateLabel(
  state: SupplyCheckState,
  category: SupplyCategory = "general",
): string {
  return CHECK_STATE_LABELS[category][state];
}

/** 학생이 누르는 버튼의 말. 준비물은 "챙겼어요", 숙제는 "다 했어요". */
export function checkActionLabel(category: SupplyCategory = "general"): string {
  return category === "homework" ? "다 했어요" : "챙겼어요";
}

/** 아직 안 한 학생을 가리키는 말. 교사 현황 화면과 재알림 문구가 함께 쓴다. */
export function uncheckedNounLabel(category: SupplyCategory = "general"): string {
  return category === "homework" ? "미완료" : "미챙김";
}

/**
 * 등록을 마쳤다고 알리는 문장. 숙제를 올리고 "준비물을 등록했어요"가 뜨면 종류를 고른
 * 보람이 없다.
 *
 * 이름만 갈아 끼우지 않고 **문장째로** 만드는 이유: 받침에 따라 조사가 갈린다
 * ("준비물**을**" vs "숙제**를**"). 이름 자리만 바꾸면 "숙제을"이 된다.
 */
export function categoryCreatedNotice(category: SupplyCategory = "general"): string {
  return category === "homework" ? "숙제를 등록했어요." : "준비물을 등록했어요.";
}

export function checkStateClassName(state: SupplyCheckState): string {
  switch (state) {
    case "checked":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "modified_unconfirmed":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "unchecked":
      return "border-slate-200 bg-slate-100 text-slate-600";
  }
}
