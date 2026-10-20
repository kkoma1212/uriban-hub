import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const stylesCss = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
const lateFontsCss = readFileSync(resolve(process.cwd(), "src/late-fonts.css"), "utf8");
const indexHtml = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const themeInitScript = readFileSync(resolve(process.cwd(), "public/theme-init.mjs"), "utf8");

function readToken(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "iu").exec(stylesCss);

  if (match?.[1] === undefined) {
    throw new Error(`Missing CSS token: --${name}`);
  }

  return match[1].toLowerCase();
}

function readScopedToken(selector: string, name: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const declarations = new RegExp(`${escapedSelector}\\s*\\{(?<declarations>[^}]+)\\}`, "u").exec(
    stylesCss,
  )?.groups?.declarations;
  const value =
    declarations === undefined
      ? undefined
      : new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "iu").exec(declarations)?.[1];

  if (value === undefined) {
    throw new Error(`Missing scoped CSS token: ${selector} / --${name}`);
  }
  return value.toLowerCase();
}

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/gu)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);

  if (channels === undefined || channels.length !== 3) {
    throw new Error(`Invalid hex color: ${hex}`);
  }

  const [red = 0, green = 0, blue = 0] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));

  return (lighter + 0.05) / (darker + 0.05);
}

describe("global visual contracts", () => {
  it("self-hosts Pretendard only, falling back to device Korean fonts, no runtime font request", () => {
    // 2026-09-27 확정 시안 본문 Pretendard Variable. 2026-10-01 사용자 결정: 보조 웹 글꼴(Noto Sans KR
    // Variable)을 빼서 휴대폰 첫 접속에 한국어 글꼴 조각을 두 벌 받지 않는다.
    expect(stylesCss).not.toContain("@fontsource-variable/noto-sans-kr");
    expect(stylesCss).toMatch(
      /--font-sans:\s*"Pretendard Variable",\s*"Noto Sans KR",\s*"Apple SD Gothic Neo"/u,
    );
    expect(stylesCss).not.toContain('"Jua"');
    // Pretendard·칠판 글씨(Gaegu)는 첫 화면 CSS 예산 밖에서 번들 파일로만 늦게 불러온다.
    expect(lateFontsCss).toContain(
      '@import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";',
    );
    expect(lateFontsCss).toContain('@import "@fontsource/gaegu/700.css";');
    expect(lateFontsCss).not.toMatch(/https?:/u);
    expect(stylesCss).not.toContain("pretendard/dist");

    expect(stylesCss).not.toMatch(/\[data-app-role="student"\][^{]*\{[^}]*font-family:/isu);
  });

  it("keeps brand colors while meeting AA contrast for muted text", () => {
    expect(readToken("color-brand-navy")).toBe("#172554");
    expect(readToken("color-brand-primary")).toBe("#335cff");
    expect(readToken("color-surface")).toBe("#f8fafc");
    expect(readToken("color-home-brand-soft")).toBe("#eef3f8");
    expect(readToken("color-home-brand-line")).toBe("#d8e1ea");

    const muted = readToken("color-text-muted");
    expect(contrastRatio(muted, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(muted, readToken("color-surface"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(muted, readToken("color-auth-surface"))).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(readToken("color-brand-navy"), readToken("color-home-brand-soft")),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("defines reusable light, dark, and role-aware semantic theme tokens", () => {
    const semanticTokens = [
      "color-app-canvas",
      "color-app-surface",
      "color-app-surface-raised",
      "color-app-surface-muted",
      "color-app-text",
      "color-app-muted",
      "color-app-border",
      "color-role-primary",
      "color-role-soft",
      "color-role-border",
      "color-danger-text",
      "color-danger-border",
      "color-danger-surface",
      "color-warning-text",
      "color-warning-border",
      "color-warning-surface",
      "color-success-text",
      "color-success-border",
      "color-success-surface",
    ] as const;
    const themeDeclarations =
      /@theme\s*\{(?<declarations>[\s\S]*?)\n\}/u.exec(stylesCss)?.groups?.declarations ?? "";

    for (const token of semanticTokens) {
      expect(themeDeclarations).toContain(`--${token}:`);
      expect(readScopedToken('[data-theme="dark"]', token)).toMatch(/^#[0-9a-f]{6}$/u);
    }

    /*
     * 밝은 테마 캔버스는 따뜻한 아이보리다(2026-08-25 Hex 결정 — 승인된 Round 5 시안).
     * 회색(밋밋하다) → 연보라(2026-08-07) → 아이보리로 온 세 번째 답이다. 값을 여기
     * 못박아 두는 이유는 이 색이 취향이 아니라 **결정**이라, 다음에 조용히 바뀌면
     * 그것이 결정을 뒤집는 일이기 때문이다.
     */
    expect(readToken("color-app-canvas")).toBe("#f6f4f0");
    // 2026-09-27 확정 시안: 어두운 테마도 연보라 기운을 빼고 무채색에 가까운 바탕으로 옮겼다.
    expect(readScopedToken('[data-theme="dark"]', "color-app-canvas")).toBe("#121614");
    // 역할색은 CI v1(칠판 로고, 2026-09-26 Hex 결정 A안): 학생 칠판 초록, 교사 나무 틀 갈색.
    // 이전 #5b4fc4 인디고는 "AI 제품" 신호, 그다음 청록·파랑은 로고와 어긋났다.
    expect(readToken("color-role-primary")).toBe("#2b6149");
    expect(readScopedToken('[data-app-role="teacher"]', "color-role-primary")).toBe("#7a4e24");
    // 밝은 테마의 교사 초록 통일은 design-foundation.css가 덮는다. 어두운 테마는 여기서 통일.
    expect(
      readScopedToken('[data-theme="dark"] [data-app-role="teacher"]', "color-role-primary"),
    ).toBe("#8fc7ae");

    expect(
      contrastRatio(readToken("color-app-text"), readToken("color-app-canvas")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(readToken("color-app-muted"), readToken("color-app-canvas")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(readToken("color-role-primary"), readToken("color-role-soft")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(readToken("color-role-primary"), readToken("color-app-canvas")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(
        readScopedToken('[data-app-role="teacher"]', "color-role-primary"),
        readToken("color-app-canvas"),
      ),
    ).toBeGreaterThanOrEqual(4.5);

    const darkSelector = '[data-theme="dark"]';
    expect(
      contrastRatio(
        readScopedToken(darkSelector, "color-app-text"),
        readScopedToken(darkSelector, "color-app-canvas"),
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(
        readScopedToken(darkSelector, "color-app-muted"),
        readScopedToken(darkSelector, "color-app-canvas"),
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(
        readScopedToken(darkSelector, "color-role-primary"),
        readScopedToken(darkSelector, "color-role-soft"),
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(
        readScopedToken(darkSelector, "color-role-primary"),
        readScopedToken(darkSelector, "color-app-canvas"),
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(readToken("color-danger"), readToken("color-app-canvas")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(
        readScopedToken(darkSelector, "color-danger"),
        readScopedToken(darkSelector, "color-app-canvas"),
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(
        readScopedToken('[data-theme="dark"] [data-app-role="teacher"]', "color-role-primary"),
        readScopedToken(darkSelector, "color-app-canvas"),
      ),
    ).toBeGreaterThanOrEqual(4.5);
  });

  /*
   * 입력창 테두리는 "여기가 입력하는 곳"을 알리는 유일한 단서다. 채우기(#ffffff)와
   * 캔버스(#f6f4fb)의 대비가 1.09라 테두리가 흐리면 입력창이 배경에 묻힌다.
   * 카드용 color-app-border를 그대로 쓰던 시절 실제 1.28~1.63이었다(2026-08-09 실측).
   * WCAG 1.4.11은 UI 구성요소 경계에 3:1을 요구한다.
   */
  it("keeps the input border distinguishable from both the field and the page", () => {
    const darkSelector = '[data-theme="dark"]';

    // 입력이 카드 경계 토큰으로 되돌아가면 이 단언이 먼저 깨진다.
    expect(stylesCss).toMatch(
      /:is\(\.auth-input, \.ui-input\)\s*\{[^}]*--input-border:\s*var\(--color-input-border\)/isu,
    );

    for (const [selector, read] of [
      ["라이트", (name: string) => readToken(name)],
      ["다크", (name: string) => readScopedToken(darkSelector, name)],
    ] as const) {
      const border = read("color-input-border");
      // 안쪽 채우기와 바깥 캔버스 양쪽에서 보여야 한다. 한쪽만 통과하면 다른 배경 위에서 사라진다.
      expect(
        contrastRatio(border, read("color-app-surface-raised")),
        `${selector} 입력 경계 vs 채우기`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(border, read("color-app-canvas")),
        `${selector} 입력 경계 vs 캔버스`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps holiday and saturday calendar days readable and distinct in both themes", () => {
    const darkSelector = '[data-theme="dark"]';

    for (const meaning of ["holiday", "saturday"] as const) {
      const text = readToken(`color-calendar-${meaning}`);
      const surface = readToken(`color-calendar-${meaning}-soft`);
      const line = readToken(`color-calendar-${meaning}-line`);
      const darkText = readScopedToken(darkSelector, `color-calendar-${meaning}`);
      const darkSurface = readScopedToken(darkSelector, `color-calendar-${meaning}-soft`);
      const darkLine = readScopedToken(darkSelector, `color-calendar-${meaning}-line`);

      expect(contrastRatio(text, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(line, readToken("color-app-surface-raised"))).toBeGreaterThanOrEqual(
        1.5,
      );
      expect(contrastRatio(darkText, darkSurface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(darkLine, darkSurface)).toBeGreaterThanOrEqual(1.5);
    }

    /*
     * 공휴일 빨강과 토요일 파랑은 **밝기가 아니라 색상으로** 갈린다. 그래서 여기서
     * 둘 사이의 대비비를 재지 않는다 — 실제로 재 보면 1.40이고, 그 숫자는 "구별된다"를
     * 증명하지도 반증하지도 못한다. 색만으로 전달하지 않을 책임은 요일 머리글과
     * 날짜의 접근 가능한 이름이 지며 그건 schedule-calendar.spec 이 잡는다.
     *
     * 여기서는 값이 실제로 갈라져 있는지, 그리고 상태색(danger)을 빌려 쓰지 않는지만
     * 본다 — 빌려 쓰는 순간 danger 팔레트를 조정할 때 달력이 소리 없이 끌려간다.
     */
    expect(readToken("color-calendar-holiday")).not.toBe(readToken("color-calendar-saturday"));
    expect(readToken("color-calendar-holiday-soft")).not.toBe(
      readToken("color-calendar-saturday-soft"),
    );
    expect(readToken("color-calendar-holiday")).not.toBe(readToken("color-danger"));
    expect(readToken("color-calendar-holiday-soft")).not.toBe(readToken("color-danger-surface"));
  });

  it("keeps danger, warning, and success states readable in both themes", () => {
    const darkSelector = '[data-theme="dark"]';
    const tones = ["danger", "warning", "success"] as const;

    for (const tone of tones) {
      const text = readToken(`color-${tone}-text`);
      const border = readToken(`color-${tone}-border`);
      const surface = readToken(`color-${tone}-surface`);
      const darkText = readScopedToken(darkSelector, `color-${tone}-text`);
      const darkBorder = readScopedToken(darkSelector, `color-${tone}-border`);
      const darkSurface = readScopedToken(darkSelector, `color-${tone}-surface`);

      expect(contrastRatio(text, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(text, readToken("color-app-surface-raised"))).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(border, surface)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(darkText, darkSurface)).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(darkText, readScopedToken(darkSelector, "color-app-surface-raised")),
      ).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(darkBorder, darkSurface)).toBeGreaterThanOrEqual(3);
    }

    expect(stylesCss).toMatch(
      /\[data-theme="dark"\][\s\S]*\.text-rose-600[\s\S]*var\(--color-danger-text\)/u,
    );
    expect(stylesCss).toMatch(
      /\[data-theme="dark"\][\s\S]*\.text-amber-800[\s\S]*var\(--color-warning-text\)/u,
    );
    expect(stylesCss).toMatch(
      /\[data-theme="dark"\][\s\S]*\.text-emerald-700[\s\S]*var\(--color-success-text\)/u,
    );
  });

  it("describes shared links with a title, description and an absolute https image", () => {
    expect(indexHtml).toContain(
      '<meta property="og:title" content="우리반 허브 — 중·고 학급 공지 확인 앱" />',
    );
    expect(indexHtml).toMatch(/<meta\s+name="description"\s+content="[^"]{20,}"/u);
    // 카톡 미리보기는 상대 주소 그림을 읽지 못한다.
    expect(indexHtml).toMatch(/<meta\s+property="og:image"\s+content="https:\/\/[^"]+\.png"/u);
  });

  it("initializes appearance before the app without an inline script", () => {
    expect(indexHtml).toContain('<meta name="color-scheme" content="light dark" />');
    expect(indexHtml).toContain('<script src="/theme-init.mjs"></script>');
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/iu);
    expect(themeInitScript).toContain('"classhub:appearance"');
    expect(themeInitScript).toContain('"(prefers-color-scheme: dark)"');
    expect(themeInitScript).toContain('root.setAttribute("data-theme", resolved)');
    expect(stylesCss).toMatch(/\[data-theme="dark"\]\s*\{[\s\S]*color-scheme:\s*dark/iu);
  });

  it("defines distinct readable accents for home cards and notice variants", () => {
    const tones = ["meal", "supplies", "important", "latest", "schedule"] as const;
    const foregrounds = tones.map((tone) => readToken(`color-home-${tone}`));
    const darkSelector = '[data-theme="dark"]';

    expect(new Set(foregrounds).size).toBe(tones.length);
    for (const tone of tones) {
      const foreground = readToken(`color-home-${tone}`);
      const surface = readToken(`color-home-${tone}-soft`);
      const darkForeground = readScopedToken(darkSelector, `color-home-${tone}`);
      const darkSurface = readScopedToken(darkSelector, `color-home-${tone}-soft`);

      expect(readToken(`color-home-${tone}-line`)).toMatch(/^#[0-9a-f]{6}$/u);
      expect(contrastRatio(foreground, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(foreground, readToken("color-app-canvas"))).toBeGreaterThanOrEqual(4.5);
      expect(readScopedToken(darkSelector, `color-home-${tone}-line`)).toMatch(/^#[0-9a-f]{6}$/u);
      expect(contrastRatio(darkForeground, darkSurface)).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(darkForeground, readScopedToken(darkSelector, "color-app-canvas")),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("does not force a 320px body width", () => {
    const bodyRule =
      /body\s*\{(?<declarations>[^}]+)\}/u.exec(stylesCss)?.groups?.declarations ?? "";

    expect(bodyRule).toMatch(/min-width:\s*0(?:px)?\s*;/u);
    expect(bodyRule).not.toMatch(/min-width:\s*320px/u);
    expect(bodyRule).not.toMatch(/overflow-x:\s*hidden/u);
  });

  it("defines shared button, focus, disabled, active, and loading states", () => {
    for (const selector of [
      ".ui-button-primary",
      ".ui-button-secondary",
      ".ui-button-tertiary",
      ".ui-button-danger",
      ".ui-button-danger-solid",
      ".ui-button-on-dark",
      ".ui-icon-button",
    ]) {
      expect(stylesCss).toContain(selector);
    }

    expect(stylesCss).toMatch(/\.ui-icon-button\s*\{[^}]*width:\s*2\.75rem/isu);
    expect(stylesCss).toMatch(/\.ui-button\s*\{[^}]*white-space:\s*nowrap/isu);
    expect(stylesCss).toMatch(/\.ui-button:active:not\(:disabled\)/u);
    expect(stylesCss).toMatch(/\.ui-icon-button:active:not\(:disabled\)/u);
    /*
     * 2026-08-12에 .ui-button:disabled 를 [class*="ui-button"]:disabled 로 넓혔다.
     * 색깔 클래스만 쓴 버튼도 흐려지게 하려는 것이고, 선택자가 짧아져 CSS 도 줄었다.
     */
    expect(stylesCss).toMatch(/\[class\*="ui-button"\]:disabled/u);
    expect(stylesCss).toMatch(/\.ui-button\[aria-busy="true"\]/u);
    expect(stylesCss).toMatch(/button:focus-visible[\s\S]*outline:/u);
    expect(stylesCss).toMatch(/a:focus-visible[\s\S]*outline:/u);
    expect(stylesCss).toMatch(
      /\[data-primary-navigation-item\]\s*\{[^}]*transition-property:\s*color,\s*background-color/isu,
    );
    expect(stylesCss).toMatch(
      /\[data-primary-navigation-item\]:focus-visible\s*\{[^}]*outline-color:\s*var\(--color-app-text\)/su,
    );
  });

  it("stops decorative motion when the operating system requests reduced motion", () => {
    expect(stylesCss).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)/u);
    expect(stylesCss).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*animation-duration:\s*0\.01ms !important/iu,
    );
    expect(stylesCss).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*animation-iteration-count:\s*1 !important/iu,
    );
    expect(stylesCss).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*scroll-behavior:\s*auto !important/iu,
    );
    expect(stylesCss).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.animate-spin\s*\{[^}]*animation-name:\s*none !important/iu,
    );
  });

  it("defines hover, focus-visible, invalid, disabled, and autofill input states", () => {
    expect(stylesCss).toContain(".ui-input-compact");
    expect(stylesCss).toContain(".ui-input-dark");
    expect(stylesCss).toMatch(/:is\(\.auth-input, \.ui-input\):hover/u);
    expect(stylesCss).toMatch(/:is\(\.auth-input, \.ui-input\):focus-visible/u);
    expect(stylesCss).toMatch(/\[aria-invalid="true"\]/u);
    expect(stylesCss).toMatch(/:is\(\.auth-input, \.ui-input\):disabled/u);
    expect(stylesCss).toMatch(/:-webkit-autofill/u);

    const inputFocusRule =
      /input:focus-visible\s*\{(?<declarations>[^}]+)\}/u.exec(stylesCss)?.groups?.declarations ??
      "";
    expect(inputFocusRule).toMatch(/outline:\s*3px\s+solid/u);
    expect(inputFocusRule).not.toMatch(/box-shadow/u);
    expect(stylesCss).toMatch(/\.ui-input-dark:focus-visible\s*\{[^}]*#8fa6ff/isu);
  });

  it("restores focus outlines and selected-state borders under forced colors", () => {
    const forcedColorsBlock = /@media \(forced-colors:\s*active\)\s*\{(?<rules>[\s\S]*?)\n\}/u.exec(
      stylesCss,
    )?.groups?.rules;
    if (forcedColorsBlock === undefined) {
      throw new Error("Missing @media (forced-colors: active) block");
    }
    // Ring utilities are box-shadow based and vanish in forced colors, so the
    // outline restoration must beat component-level `outline-none`.
    expect(forcedColorsBlock).toMatch(
      /a:focus-visible[\s\S]*outline:\s*3px\s+solid\s+CanvasText\s*!important/u,
    );
    expect(forcedColorsBlock).toMatch(/\[tabindex\]:focus-visible/u);
    expect(forcedColorsBlock).toMatch(/\[aria-current="page"\]/u);
    expect(forcedColorsBlock).toMatch(/\[role="tab"\]\[aria-selected="true"\]/u);
  });

  it("groups long Korean consent copy without isolating the document note on mobile", () => {
    expect(stylesCss).toMatch(
      /\.auth-consent-row\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*1\.25rem minmax\(0, 1fr\)/isu,
    );
    expect(stylesCss).toMatch(/\.auth-consent-copy\s*\{[^}]*word-break:\s*keep-all/isu);
    expect(stylesCss).toMatch(
      /\.auth-consent-meta\s*\{[^}]*grid-column:\s*2[^}]*white-space:\s*nowrap/isu,
    );
    expect(stylesCss).toMatch(/@media \(min-width:\s*400px\)/u);
    expect(stylesCss).toMatch(
      /@media \(min-width:\s*400px\)[\s\S]*\.auth-consent-row\s*\{[^}]*display:\s*flex/iu,
    );
  });

  /*
   * 이 덫이 왜 있나: 2026-08-07에 모서리 토큰을 카드 26px→16px로 줄였는데, 실제 카드
   * 42곳이 rounded-3xl(24px)을 클래스에 박고 있어 화면은 하나도 안 줄었다. 토큰과
   * 클래스가 갈라진 것을 아무도 못 잡았다 — 어떤 테스트도 모서리를 안 봤기 때문이다.
   * 값이 아니라 "토큰을 거치지 않는 카드 모서리가 있는가"를 검사한다. 값을 박으면
   * 다음에 정책이 바뀔 때 이 테스트가 정책과 함께 뒤처진다.
   */
  it("routes every card corner through the radius token instead of a hardcoded class", () => {
    const featureSources = globSync("src/features/**/*.tsx", { cwd: process.cwd() })
      .filter((path) => !path.endsWith(".spec.tsx"))
      .map((path) => ({ path, source: readFileSync(resolve(process.cwd(), path), "utf8") }));

    // 스윕이 실제로 파일을 읽었는지부터 확인한다. glob이 0건을 돌려주면 아래 단언이
    // 통째로 무의미해지는데 통과로 보인다.
    expect(featureSources.length).toBeGreaterThan(50);

    const offenders = featureSources
      .filter(({ source }) => /\brounded-3xl\b/u.test(source))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);

    // 카드 토큰이 실제로 쓰이고 있는지도 같이 본다. 위 단언은 rounded-card 를 전부
    // 지워도 통과하므로, 그 경우를 여기서 막는다.
    const cardTokenUsers = featureSources.filter(({ source }) =>
      /\brounded-card\b/u.test(source),
    ).length;
    expect(cardTokenUsers).toBeGreaterThan(15);
  });

  /*
   * 색깔 클래스만 쓰고 기본 ui-button 을 빠뜨리면, 눌리지 않는 버튼이 눌리는 것처럼
   * 진하게 보인다. 2026-08-12 선거 화면에서 다섯 곳이 그랬고 눈으로만 잡혔다.
   * CSS 에 안전망을 걸었지만 올바른 쓰임도 함께 지킨다 — 안전망만 믿으면 다른
   * 스타일(패딩·줄바꿈)이 조용히 빠진다.
   */
  /*
   * 폰 브라우저에서 100vh(min-h-screen)는 주소창이 숨겨진 상태를 기준으로 잰다.
   * 그래서 화면에 다 들어오는 내용인데도 늘 조금 넘쳐 스크롤이 생긴다 —
   * 2026-08-12 Hex 가 "조금 내려야 밑부분이 완전히 보인다"고 잡았다.
   * dvh 는 실제로 보이는 높이라 그 어긋남이 없다.
   */
  it("measures full-height screens with dvh instead of vh", () => {
    const featureSources = globSync("src/features/**/*.tsx", { cwd: process.cwd() })
      .filter((path) => !path.endsWith(".spec.tsx"))
      .map((path) => ({ path, source: readFileSync(resolve(process.cwd(), path), "utf8") }));
    expect(featureSources.length).toBeGreaterThan(50);

    const offenders = featureSources
      .filter(({ source }) => /\b(min-h-screen|h-screen)\b/u.test(source))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);

    // dvh 가 실제로 쓰이는지도 본다 — 위 단언은 전부 지워도 통과한다.
    const dvhUsers = featureSources.filter(({ source }) => /\bmin-h-dvh\b/u.test(source)).length;
    expect(dvhUsers).toBeGreaterThan(3);
  });

  it("keeps the base ui-button class next to every colour modifier", () => {
    const featureSources = globSync("src/features/**/*.tsx", { cwd: process.cwd() })
      .filter((path) => !path.endsWith(".spec.tsx"))
      .map((path) => ({ path, source: readFileSync(resolve(process.cwd(), path), "utf8") }));
    expect(featureSources.length).toBeGreaterThan(50);

    const modifier = /class(?:Name)?="([^"]*\bui-button-[a-z-]+[^"]*)"/gu;
    const offenders: string[] = [];
    for (const { path, source } of featureSources) {
      for (const match of source.matchAll(modifier)) {
        /*
         * 낱말 단위로 쪼개 정확히 비교한다. 정규식 \bui-button\b 로 보면
         * "ui-button-primary" 안에서도 맞아 떨어져 검사가 통째로 무의미해진다
         * (2026-08-12에 일부러 깨뜨려 보고서야 알았다).
         */
        const tokens = (match[1] ?? "").split(/\s+/u);
        if (!tokens.includes("ui-button") && !tokens.includes("ui-icon-button")) {
          offenders.push(`${path}: ${(match[1] ?? "").slice(0, 60)}`);
        }
      }
    }
    expect(offenders).toEqual([]);

    // 안전망이 CSS 에 실제로 있는지도 확인한다 — 지워지면 이 계약이 반쪽이 된다.
    expect(stylesCss).toMatch(/\[class\*="ui-button"\]:disabled/u);
  });
});
