export interface ServiceMailContent {
  title: string;
  paragraphs: readonly string[];
  action?: { label: string; url: string };
  code?: string;
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

/** A single email layout; values are escaped and credentials are never included. */
export function serviceMail(content: ServiceMailContent): { text: string; html: string } {
  const note = content.note ?? "요청한 적이 없다면 이 메일을 무시해 주세요.";
  return {
    text: [
      "우리반 허브",
      content.title,
      ...content.paragraphs,
      ...(content.code === undefined ? [] : [`확인번호: ${content.code}`]),
      ...(content.action === undefined ? [] : [`${content.action.label}: ${content.action.url}`]),
      note,
    ].join("\n\n"),
    html: `<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body style="margin:0;background:#f5f6fa;color:#202b3d;font-family:Arial,'Malgun Gothic',sans-serif"><table role="presentation" style="width:100%;padding:32px 16px"><tr><td align="center"><table role="presentation" style="width:100%;max-width:560px;background:#fff;border:1px solid #dfe4ec;border-radius:16px"><tr><td style="padding:28px"><p style="margin:0 0 20px;color:#334b83;font-size:14px;font-weight:700">우리반 허브</p><h1 style="margin:0 0 20px;font-size:24px;line-height:1.4">${escapeHtml(content.title)}</h1>${content.paragraphs.map((paragraph) => `<p style="font-size:16px;line-height:1.8;margin:0 0 16px">${escapeHtml(paragraph)}</p>`).join("")}${content.code === undefined ? "" : `<p style="padding:20px;background:#f1f4fa;border-radius:12px;text-align:center;font-size:30px;letter-spacing:8px;font-weight:700">${escapeHtml(content.code)}</p>`}${content.action === undefined ? "" : `<p style="margin:24px 0"><a href="${escapeHtml(content.action.url)}" style="display:inline-block;padding:14px 22px;background:#334b83;color:#fff;text-decoration:none;border-radius:10px;font-weight:700">${escapeHtml(content.action.label)}</a></p><p style="font-size:12px;word-break:break-all;color:#5c677b">버튼이 열리지 않으면 이 주소를 복사해 주세요.<br>${escapeHtml(content.action.url)}</p>`}<p style="margin-top:28px;padding-top:20px;border-top:1px solid #dfe4ec;font-size:13px;line-height:1.7;color:#5c677b">${escapeHtml(note)}</p></td></tr></table></td></tr></table></body></html>`,
  };
}
