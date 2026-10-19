/** 임시저장이 담기는 화면. DB의 `kind` CHECK와 같은 값이어야 한다. */
export const LAYOUT_DRAFT_KINDS = ["seat_draw", "team_draw"] as const;

export type LayoutDraftKind = (typeof LAYOUT_DRAFT_KINDS)[number];

export function isLayoutDraftKind(value: string): value is LayoutDraftKind {
  return (LAYOUT_DRAFT_KINDS as readonly string[]).includes(value);
}

export interface LayoutDraftItem {
  kind: LayoutDraftKind;
  /*
   * 마법사가 들고 있던 상태를 그대로 돌려준다. 서버는 이 안을 해석하지 않는다 —
   * 단계 구성은 화면과 함께 바뀌고, 서버가 모양을 알면 화면을 고칠 때마다 서버도
   * 함께 고쳐야 한다. 서버가 지키는 것은 "누구 것인가"와 "언제 손댔나"뿐이다.
   */
  payload: unknown;
  row_version: string;
  updated_at: string;
}
