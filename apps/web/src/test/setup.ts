import { configure } from "@testing-library/react";

import "@testing-library/jest-dom/vitest";
import { beforeEach, vi } from "vitest";

import { forgetAllBadgeCounts } from "../features/layout/badge-count-cache";

// 메뉴 숫자 기억(badge-count-cache)이 앞 테스트의 값을 다음 테스트로 넘기지 않게 한다.
beforeEach(() => forgetAllBadgeCounts());

/*
 * 공용 틀(app-shell)의 점검 안내 줄은 화면이 뜰 때마다 /api/v1/public/system-state를
 * 따로 묻고, 못 읽으면 role="alert"를 띄운다. 화면별 시험은 자기 화면의 요청 수와
 * 알림만 세므로 이 줄이 끼면 화면과 무관하게 깨진다(b839be39 이후 웹 89건 실패).
 * 안내 줄 자체의 동작은 system-state-banner.spec.tsx가 실제 부품으로 따로 지킨다.
 */
vi.mock("../features/layout/system-state-banner", () => ({ SystemStateBanner: () => null }));

/*
 * T-HUB-27 진단 — 요소를 못 찾은 "그 순간"의 조작 가능한 DOM을 남긴다.
 *
 * 왜 필요한가: 전체 게이트에서만 `findBy*`가 터지는 관측이 다섯 번 났는데,
 * 매번 재실행하면 통과해 원인을 볼 기회가 사라졌다. 2026-08-16 실측으로
 * "부하 때문에 느렸다"는 설명은 죽었다 — 같은 테스트가 단독 61ms, 전체 게이트와
 * 동시 실행에서도 108ms(1.8배)인데 실패는 5,062ms(83배)였다. 즉 늦게 나타난 게
 * 아니라 **끝내 안 나타났다**. 그렇다면 봐야 할 것은 "얼마나 걸렸나"가 아니라
 * 포기하는 순간 화면에 무엇이 있었나다.
 *
 * 기본 오류 메시지도 DOM을 담지만 body 전체라 길이 제한에 잘리고, 정작 묻고 싶은
 * 것(버튼이 있었나 · 눌리는 상태였나 · 대화상자가 열렸다 닫혔나)이 한눈에 안 온다.
 * 그래서 요약 몇 줄을 덧붙인다. 기존 메시지는 그대로 두고 뒤에 붙이기만 한다.
 */
function summarizeInteractiveDom(container: Element | null | undefined): string {
  const root = container ?? (typeof document === "undefined" ? null : document.body);
  if (root === null) return "[T-HUB-27] 진단 불가 — DOM 없음";

  const lines: string[] = ["[T-HUB-27] 못 찾은 순간의 화면 상태"];

  const buttons = Array.from(root.querySelectorAll("button"));
  lines.push(`  버튼 ${buttons.length}개`);
  for (const button of buttons.slice(0, 20)) {
    const label = (button.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 70);
    const flags = [
      button.disabled ? "disabled" : "",
      button.getAttribute("aria-busy") === "true" ? "aria-busy" : "",
    ].filter(Boolean);
    lines.push(`    - "${label}"${flags.length > 0 ? ` [${flags.join(" ")}]` : ""}`);
  }
  if (buttons.length > 20) lines.push(`    … 그 밖 ${buttons.length - 20}개`);

  for (const role of ["dialog", "alert", "status"]) {
    const found = Array.from(root.querySelectorAll(`[role="${role}"]`));
    const texts = found.map((element) =>
      (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 90),
    );
    lines.push(
      `  role="${role}" ${found.length}개${texts.length > 0 ? `: ${texts.join(" | ")}` : ""}`,
    );
  }

  return lines.join("\n");
}

// The default 1s budget for findBy*/waitFor is measured on an idle machine. The
// full suite runs alongside the rest of `pnpm check`, where the same assertions
// need several seconds. Keep real failures failing, just not on machine load.
//
// ⚠️ 2026-08-16: 이 5초를 늘리는 것으로 T-HUB-27을 덮지 말 것. 실측상 실패는
// 감속이 아니라 "영영 안 나타남"이라 늘려도 안 고쳐지고 실패까지의 대기만 길어진다.
configure({
  asyncUtilTimeout: 5_000,
  getElementError(message, container) {
    const error = new Error(`${message ?? ""}\n\n${summarizeInteractiveDom(container)}`);
    error.name = "TestingLibraryElementError";
    return error;
  },
});
