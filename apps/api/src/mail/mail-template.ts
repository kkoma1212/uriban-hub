export interface ServiceMailContent {
  title: string;
  paragraphs: readonly string[];
  /** The one value the reader came for (for example the account id), shown in its own box. */
  highlight?: { label: string; value: string };
  action?: { label: string; url: string };
  code?: string;
  /** 번호 상자와 글자본에 붙는 이름. 화면이 부르는 이름과 같아야 한다(기본 '인증번호'). */
  codeLabel?: string;
  note?: string;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

// 2026-10-20 사용자 선택 시안 A '칠판 인사': 앱 로고(CI v1 칠판)와 같은 색으로 메일 머리에 작은 칠판을 그린다.
// 메일함은 웹 글꼴·SVG·그라데이션을 지우고 그림을 막기도 하므로 표 구조와 글자마다 붙인 스타일만 쓴다.
// 노란 분필은 앱 규칙(노랑 = 중요·바뀐 것)대로 밑줄 장식에만 쓰고 버튼에는 쓰지 않는다.
const COLOR = {
  board: "#2B6149",
  boardDeep: "#1E4536",
  wood: "#C99A5B",
  chalk: "#F6F3EA",
  chalkSoft: "#CFE3D6",
  yellow: "#F5C842",
  canvas: "#F6F4F0",
  ink: "#20201D",
  body: "#3B3A36",
  muted: "#6F6A61",
  line: "#E7E1D6",
  soft: "#E6F0EA",
  softLine: "#A9CBB6",
  noteSurface: "#FFF8E1",
  noteText: "#6B5A1E",
} as const;
const FONT = "'Pretendard','Apple SD Gothic Neo','Malgun Gothic','맑은 고딕',sans-serif";
const MONO = "Consolas,'Courier New',monospace";
const TABLE = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';

/** A colored strip (chalk underline, chalk tray) drawn as a table cell instead of an image. */
function strip(width: string, height: number, color: string, style = ""): string {
  return `<table ${TABLE} width="${width}" style="${style}"><tr><td height="${height}" style="height:${height}px;line-height:${height}px;font-size:0;background:${color};border-radius:${height}px">&nbsp;</td></tr></table>`;
}

// &#9999;&#65039; = 연필 그림 문자. 소스에 보이지 않는 변형 문자가 섞이지 않도록 숫자 표기로 쓴다.
function chalkboardHeader(): string {
  return `<tr><td style="background:${COLOR.board};border:6px solid ${COLOR.wood};border-radius:16px;padding:18px 22px 20px"><table ${TABLE} width="100%"><tr><td style="font-size:20px;line-height:1.3;font-weight:800;color:${COLOR.chalk};font-family:${FONT}">&#9999;&#65039; 우리반 허브</td><td align="right" style="font-size:12px;line-height:1.3;font-weight:700;color:${COLOR.chalkSoft};font-family:${FONT}">우리 반 알림장</td></tr></table>${strip("104", 6, COLOR.yellow, "margin-top:9px")}</td></tr><tr><td style="padding:6px 44px 0">${strip("100%", 7, COLOR.wood)}</td></tr>`;
}

function highlightBox(highlight: { label: string; value: string }): string {
  return `<table ${TABLE} width="100%" style="margin:4px 0 16px;background:${COLOR.soft};border:1px solid ${COLOR.softLine};border-radius:14px"><tr><td style="padding:14px 18px"><div style="font-size:12px;line-height:1.4;font-weight:700;color:${COLOR.board}">${escapeHtml(highlight.label)}</div><div style="margin-top:4px;font-size:18px;line-height:1.4;font-weight:800;color:${COLOR.boardDeep};word-break:break-all">${escapeHtml(highlight.value)}</div></td></tr></table>`;
}

// letter-spacing은 마지막 글자 뒤에도 붙으므로 같은 폭을 왼쪽에 채워 숫자를 가운데에 둔다.
function codeChalkboard(code: string, label: string): string {
  return `<table ${TABLE} width="100%" style="margin:6px 0 20px"><tr><td align="center" style="background:${COLOR.board};border:5px solid ${COLOR.wood};border-radius:14px;padding:12px 10px 16px"><div style="font-size:12px;line-height:1.4;font-weight:700;letter-spacing:1px;color:${COLOR.chalkSoft}">${escapeHtml(label)}</div><div style="font-size:34px;line-height:1.35;font-weight:800;letter-spacing:10px;padding-left:10px;color:${COLOR.chalk};font-family:${MONO}">${escapeHtml(code)}</div><table ${TABLE} align="center" width="64"><tr><td height="5" style="height:5px;line-height:5px;font-size:0;background:${COLOR.yellow};border-radius:5px">&nbsp;</td></tr></table></td></tr></table>`;
}

function actionButton(action: { label: string; url: string }): string {
  const url = escapeHtml(action.url);
  return `<table ${TABLE} style="margin:20px 0 12px"><tr><td style="background:${COLOR.board};border-radius:999px;border-bottom:3px solid ${COLOR.boardDeep}"><a href="${url}" style="display:inline-block;padding:14px 30px;font-size:16px;line-height:1.2;font-weight:800;color:#FFFFFF;text-decoration:none;font-family:${FONT}">${escapeHtml(action.label)} <span aria-hidden="true">&rarr;</span></a></td></tr></table><p style="margin:0 0 4px;font-size:12px;line-height:1.6;color:${COLOR.muted};word-break:break-all">버튼이 눌리지 않으면 아래 주소를 복사해 주소창에 붙여 넣어 주세요.<br><a href="${url}" style="color:${COLOR.board};text-decoration:underline">${url}</a></p>`;
}

/** A single email layout; values are escaped and credentials are never included. */
export function serviceMail(content: ServiceMailContent): { text: string; html: string } {
  const note = content.note ?? "직접 요청하지 않았다면 이 메일은 무시해도 괜찮아요.";
  const codeLabel = content.codeLabel ?? "인증번호";
  const paragraphs = content.paragraphs
    .map(
      (paragraph) =>
        `<p style="margin:0 0 12px;font-size:16px;line-height:1.75;color:${COLOR.body}">${escapeHtml(paragraph)}</p>`,
    )
    .join("");
  const body = [
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.45;font-weight:800;color:${COLOR.ink}">${escapeHtml(content.title)}</h1>`,
    paragraphs,
    content.highlight === undefined ? "" : highlightBox(content.highlight),
    content.code === undefined ? "" : codeChalkboard(content.code, codeLabel),
    content.action === undefined ? "" : actionButton(content.action),
  ].join("");
  return {
    text: [
      "우리반 허브",
      content.title,
      ...content.paragraphs,
      ...(content.highlight === undefined
        ? []
        : [`${content.highlight.label}: ${content.highlight.value}`]),
      ...(content.code === undefined ? [] : [`${codeLabel}: ${content.code}`]),
      ...(content.action === undefined ? [] : [`${content.action.label}: ${content.action.url}`]),
      note,
    ].join("\n\n"),
    html: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"></head><body style="margin:0;padding:0;background:${COLOR.canvas}"><table ${TABLE} width="100%" style="background:${COLOR.canvas}"><tr><td align="center" style="padding:28px 14px 36px"><table ${TABLE} width="100%" style="max-width:540px;font-family:${FONT}">${chalkboardHeader()}<tr><td style="padding-top:16px"><table ${TABLE} width="100%" style="background:#FFFFFF;border:1px solid ${COLOR.line};border-radius:18px"><tr><td style="padding:28px 26px 6px">${body}</td></tr><tr><td style="padding:14px 26px 26px"><table ${TABLE} width="100%" style="background:${COLOR.noteSurface};border-radius:12px"><tr><td style="padding:12px 14px;font-size:13px;line-height:1.65;color:${COLOR.noteText}">&#128161; ${escapeHtml(note)}</td></tr></table></td></tr></table></td></tr><tr><td align="center" style="padding:20px 12px 0;font-size:12px;line-height:1.7;color:${COLOR.muted}">우리반 허브에서 보낸 메일이에요</td></tr></table></td></tr></table></body></html>`,
  };
}
