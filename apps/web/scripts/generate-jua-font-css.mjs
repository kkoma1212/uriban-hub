// Regenerates the woff2-only Jua slice stylesheet from @fontsource/jua.
// Run after bumping the @fontsource/jua version:
//   node scripts/generate-jua-font-css.mjs
import { Console } from "node:console";
import { readFile, writeFile } from "node:fs/promises";
import { stdout } from "node:process";
import { URL } from "node:url";

const output = new Console(stdout);

const SOURCE = new URL("../node_modules/@fontsource/jua/index.css", import.meta.url);
const TARGET = new URL("../src/features/theme/jua-font.css", import.meta.url);

const source = await readFile(SOURCE, "utf8");
const faces = source.match(/@font-face\s*\{[^}]*\}/gu) ?? [];
if (faces.length < 80) {
  throw new Error(`unexpected @fontsource/jua slice count: ${faces.length}`);
}

// 기존 단일 파일은 한글 음절 전영역과 기본 라틴을 덮었다. 슬라이스 합집합이
// 같은 영역을 빠짐없이 덮는지 증명하지 못하면 생성하지 않는다.
const covered = new Set();
for (const face of faces) {
  const range = /unicode-range:\s*([^;]+);/u.exec(face)?.[1] ?? "";
  for (const part of range.split(",")) {
    const single = /^\s*U\+([0-9a-f]+)\s*$/iu.exec(part);
    const span = /^\s*U\+([0-9a-f]+)-([0-9a-f]+)\s*$/iu.exec(part);
    if (single) covered.add(Number.parseInt(single[1], 16));
    else if (span) {
      const from = Number.parseInt(span[1], 16);
      const to = Number.parseInt(span[2], 16);
      for (let codePoint = from; codePoint <= to; codePoint += 1) covered.add(codePoint);
    }
  }
}
const requiredRanges = [
  [0xac00, 0xd7a3, "한글 음절"],
  [0x0020, 0x007e, "기본 라틴"],
];
for (const [from, to, label] of requiredRanges) {
  for (let codePoint = from; codePoint <= to; codePoint += 1) {
    if (!covered.has(codePoint)) {
      throw new Error(`${label} U+${codePoint.toString(16)} 가 어떤 슬라이스에도 없음`);
    }
  }
}

const woff2Only = faces.map((face) => {
  const rewritten = face
    // 정책상 woff2만 배포한다. woff 폴백 소스를 제거한다.
    .replace(/,\s*url\(\.\/files\/[^)]+\.woff\)\s*format\('woff'\)/gu, "")
    // Vite가 node_modules에서 해석하도록 패키지 경로로 바꾼다.
    .replaceAll("url(./files/", "url(@fontsource/jua/files/");
  if (/\.woff["')]/u.test(rewritten)) {
    throw new Error("woff fallback survived the rewrite");
  }
  if (!/unicode-range:/u.test(rewritten)) {
    throw new Error("slice without unicode-range");
  }
  return rewritten;
});

const banner = `/*
 * 생성 파일 — 직접 수정하지 말 것.
 * @fontsource/jua의 유니코드 슬라이스에서 woff2 소스만 추려 만든다.
 * 재생성: node scripts/generate-jua-font-css.mjs
 * 이 파일은 학생 화면에서만 동적 import되어 초기 CSS 예산에 포함되지 않는다.
 */
`;

await writeFile(TARGET, `${banner}\n${woff2Only.join("\n\n")}\n`);
output.log(`generated ${woff2Only.length} woff2-only Jua faces`);
