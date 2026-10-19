/*
 * 교실 배치 템플릿 — 자리 만들기 1단계에서 정하는 **교실의 책상 배치**를 이름 붙여
 * 저장해 두고 다시 불러 쓴다.
 *
 * ⚠️ 표 이름은 `classroom_layout_templates` 이고 경로는 `/layout-templates` 다. 경로는
 * 형제 기능인 `/layout-drafts`(임시저장)와 줄을 맞추고, 표 이름은 "무엇을 담는가"를
 * 드러낸다 — 담는 것은 교실 배치뿐이고 학생 명단·고정 자리는 담지 않는다.
 */

export interface LayoutTemplateItem {
  created_at: string;
  id: string;
  name: string;
  /*
   * 마법사 1단계가 들고 있던 배치를 그대로 돌려준다. 서버는 이 안을 해석하지 않는다 —
   * 임시저장과 같은 이유다(단계 구성이 화면과 함께 바뀐다). 서버가 지키는 것은
   * "누구 것인가" · "이름이 겹치지 않는가" · "너무 크지 않은가" 셋뿐이다.
   */
  payload: unknown;
  updated_at: string;
}

export interface LayoutTemplateListResult {
  items: LayoutTemplateItem[];
}
