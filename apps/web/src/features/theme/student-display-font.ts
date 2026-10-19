let requested = false;

/**
 * 학생 표시용 Jua 슬라이스 스타일시트를 1회만 지연 로드한다.
 * 초기 CSS 예산 밖의 동적 청크이며, 실패 시 다음 학생 화면에서 재시도한다.
 * 로드 전에는 `font-display: swap` 폴백(본문 sans)이 그대로 보인다.
 */
export function ensureStudentDisplayFont(
  load: () => Promise<unknown> = () => import("./jua-font.css"),
): void {
  if (requested) return;
  requested = true;
  void load().catch(() => {
    requested = false;
  });
}

export function resetStudentDisplayFontForTests(): void {
  requested = false;
}
