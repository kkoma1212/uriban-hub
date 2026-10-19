// 홈 화면·알림용 앱 아이콘 PNG를 만든다.
// 이미지 도구 의존성을 늘리지 않으려고 Node 기본 zlib로 직접 그린다.
// 모양(보라 바탕 + 흰 체크)은 임시안이다. 로고가 정해지면 이 스크립트나 PNG만 바꾸면 된다.
// ⚠️ 2026-09-26부터 public/icons는 CI v1(칠판 로고, 저장소 밖 디자인 시안 CI_v1/png)의 PNG다. 이 스크립트를 실행하면 옛 보라 아이콘으로 덮어쓴다.
// 실행: node apps/web/scripts/generate-app-icons.mjs
import { Buffer } from "node:buffer";
import { Console } from "node:console";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const output = new Console(stdout);
const OUTPUT_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../public/icons");
const BACKGROUND = [0x5b, 0x4f, 0xc4]; // manifest theme_color와 같은 색
const FOREGROUND = [0xff, 0xff, 0xff];
const SUPERSAMPLE = 4; // 가장자리 계단 현상을 줄이려고 픽셀당 4×4 표본을 평균한다.

const ICONS = [
  // any: 둥근 사각형. maskable/apple: 기기가 모서리를 자르므로 전체를 채운다.
  { file: "icon-192.png", size: 192, fullBleed: false },
  { file: "icon-512.png", size: 512, fullBleed: false },
  { file: "icon-maskable-512.png", size: 512, fullBleed: true },
  { file: "apple-touch-icon.png", size: 180, fullBleed: true },
];

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function insideRoundedSquare(x, y, radius) {
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  return Math.hypot(x - cx, y - cy) <= radius;
}

// 좌표는 0~1 정규화. 체크는 maskable 안전 영역(가운데 80%) 안에 둔다.
function sample(x, y, fullBleed) {
  if (!fullBleed && !insideRoundedSquare(x, y, 0.22)) return null;
  const stroke = 0.075;
  const onCheck =
    distanceToSegment(x, y, 0.3, 0.52, 0.44, 0.66) <= stroke ||
    distanceToSegment(x, y, 0.44, 0.66, 0.71, 0.37) <= stroke;
  return onCheck ? FOREGROUND : BACKGROUND;
}

function renderRgba(size, fullBleed) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const color = sample(
            (px + (sx + 0.5) / SUPERSAMPLE) / size,
            (py + (sy + 0.5) / SUPERSAMPLE) / size,
            fullBleed,
          );
          if (color === null) continue;
          r += color[0];
          g += color[1];
          b += color[2];
          covered += 1;
        }
      }
      const offset = (py * size + px) * 4;
      if (covered > 0) {
        pixels[offset] = Math.round(r / covered);
        pixels[offset + 1] = Math.round(g / covered);
        pixels[offset + 2] = Math.round(b / covered);
      }
      pixels[offset + 3] = Math.round((covered / samples) * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // 채널당 8비트
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    rows[y * (size * 4 + 1)] = 0; // 필터 없음
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
for (const icon of ICONS) {
  const png = encodePng(icon.size, renderRgba(icon.size, icon.fullBleed));
  writeFileSync(resolve(OUTPUT_DIRECTORY, icon.file), png);
  output.log(`${icon.file} ${icon.size}px ${png.length} bytes`);
}
