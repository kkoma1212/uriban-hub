/**
 * 만든 파일(Blob)을 내려받게 한다 — 평가 CSV·반 기록·관리자 CSV 2곳이 같이 쓴다(2026-10-23 합침).
 * 링크를 문서에 붙인 채 눌러야 받는 브라우저가 있고, 내려받기를 늦게 시작하는 브라우저는 같은 차례에
 * 주소를 지우면 받기가 취소된다 — 그래서 붙였다 떼고, 주소는 10초 뒤에 지운다.
 */
export function saveBlobAsFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
