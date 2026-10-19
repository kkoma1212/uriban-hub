import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const foundationCss = readFileSync(resolve(process.cwd(), "src/design-foundation.css"), "utf8");

function lightToken(name: string): string {
  const lightTheme = /:root:not\(\[data-theme="dark"\]\)\s*\{(?<body>[\s\S]*?)\n\}/u.exec(
    foundationCss,
  )?.groups?.body;
  const value =
    lightTheme === undefined
      ? undefined
      : new RegExp(`--${name}:\\s*([^;]+);`, "u").exec(lightTheme)?.[1]?.trim();

  if (value === undefined) throw new Error(`Missing approved light token: --${name}`);
  return value.toLowerCase();
}

// 2026-09-27 확정 시안(칠판 + 소식 흐름)이 승인한 밝은 테마 값. 어두운 테마는 바꾸지 않는다.
describe("2026-09-27 approved common design foundation", () => {
  it("pins the approved light palette without replacing the dark palette", () => {
    expect(lightToken("color-app-canvas")).toBe("#efe8dc");
    expect(lightToken("color-app-surface-muted")).toBe("#f0f2ef");
    expect(lightToken("color-app-text")).toBe("#16191b");
    expect(lightToken("color-app-muted")).toBe("#5d6468");
    expect(lightToken("color-app-muted-on-tint")).toBe("#5a6165");
    expect(lightToken("color-app-border")).toBe("#e2e5e1");
    expect(lightToken("color-role-primary")).toBe("#1e4536");
    expect(lightToken("radius-control")).toBe("0.75rem");
    expect(lightToken("radius-card")).toBe("1.25rem");
    expect(lightToken("radius-shell")).toBe("1.5rem");
    // 어두운 테마 예외는 선택 테두리 하나뿐 — 10-13 기기 검수(7def2053)에서 대비 3.3→5.5:1 이상으로 확정.
    const darkBlocks = [...foundationCss.matchAll(/\[data-theme="dark"\]\s*\{([^}]*)\}/gu)].map(
      (match) => match[1]?.trim(),
    );
    expect(darkBlocks).toEqual(["--color-focus-ring: #d98a3a;"]);
  });

  it("defines the rail, teacher, administrator, focus, and shadow contracts", () => {
    // 밝은 테마 PC 메뉴는 흰 바탕, 어두운 테마는 짙은 무채색 메뉴(:root 기본값).
    expect(lightToken("color-shell-rail")).toBe("#f7f3ec");
    expect(foundationCss).toContain("--color-shell-rail: #161b18;");
    expect(foundationCss).toContain("--color-shell-rail-muted: #c3cbc6;");
    expect(foundationCss).toContain("--color-focus-ring: #b85c00;");
    // 시안은 교사도 칠판 초록 한 가지 강조색을 쓴다(9/26 나무 갈색에서 통일).
    expect(foundationCss).toMatch(
      /:root:not\(\[data-theme="dark"\]\) \[data-app-role="teacher"\][^{]*\{[^}]*--color-role-primary:\s*#1e4536;/su,
    );
    expect(foundationCss).toMatch(
      /:root:not\(\[data-theme="dark"\]\) \[data-app-role="admin"\][^{]*\{[^}]*--color-role-primary:\s*#6554a4;/su,
    );
    expect(lightToken("shadow-card")).not.toBe("none");
  });

  it("keeps the desktop rail and mobile five-tab surface structurally named", () => {
    expect(foundationCss).toMatch(/\.app-desktop-rail\s*\{/u);
    expect(foundationCss).toMatch(/\.app-bottom-navigation\s*\{/u);
    // Tailwind lg(64rem)와 같은 기준이라 글자 크기를 키워도 메뉴와 화면이 같은 폭에서 바뀐다.
    expect(foundationCss).toMatch(/@media \(min-width: 64rem\)/u);
    // 선택 안 된 아래 탭 글자는 테마 공통 흐린 글자색(밝은 테마 #5d6468, 흰 바탕 6.0:1)을 쓴다 — 고정 색을 다시 칠하지 않는다.
    expect(foundationCss).not.toMatch(
      /\.app-bottom-navigation \[data-primary-navigation-item\]\s*\{/u,
    );
  });
});
