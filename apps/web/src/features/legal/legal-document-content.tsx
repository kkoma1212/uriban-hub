import { Fragment } from "react";

function inlineText(text: string): React.ReactNode {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https:\/\/[^\s)]+\))/u)
    .map((part, index) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={index}>{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith("`") && part.endsWith("`")) {
        return (
          <code className="break-words rounded bg-app-surface-muted px-1 text-[0.9em]" key={index}>
            {part.slice(1, -1)}
          </code>
        );
      }
      const link = /^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/u.exec(part);
      if (link !== null) {
        return (
          <a
            className="break-words underline underline-offset-4"
            href={link[2]}
            key={index}
            rel="noopener noreferrer"
            target="_blank"
          >
            {link[1]}
          </a>
        );
      }
      return <Fragment key={index}>{part}</Fragment>;
    });
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/gu, "")
    .split("|")
    .map((cell) => cell.trim());
}

function DocumentTable({ lines }: { lines: string[] }): React.JSX.Element {
  const headers = cells(lines[0] ?? "");
  const rows = lines.slice(2).map(cells);
  return (
    <div
      className="my-5 min-w-0 overflow-x-auto rounded-xl border border-app-border"
      tabIndex={0}
      aria-label="문서 상세 표"
    >
      <table className="w-full min-w-[640px] border-collapse text-left text-sm leading-6">
        <thead className="bg-app-surface-muted">
          <tr>
            {headers.map((header, index) => (
              <th
                className="border-b border-app-border p-3 align-top font-bold"
                key={index}
                scope="col"
              >
                {inlineText(header)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td className="border-b border-app-border p-3 align-top" key={index}>
                  {inlineText(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LegalDocumentContent({ content }: { content: string }): React.JSX.Element {
  const blocks = content.replace(/\r\n/gu, "\n").split(/\n\s*\n/u);
  return (
    <div
      className="min-w-0 break-words text-sm leading-7 text-app-text"
      data-legal-document-content="true"
    >
      {blocks.map((block, index) => {
        const lines = block.split("\n");
        if (/^\|.*\|\s*$/u.test(lines[0] ?? "") && /^\|[\s:|-]+\|\s*$/u.test(lines[1] ?? "")) {
          return <DocumentTable key={index} lines={lines} />;
        }
        const heading = /^(#{1,3})\s+(.+)$/u.exec(block);
        if (heading !== null) {
          return heading[1]!.length < 3 ? (
            <h2 className="mb-3 mt-8 text-lg font-extrabold" key={index}>
              {inlineText(heading[2]!)}
            </h2>
          ) : (
            <h3 className="mb-2 mt-6 text-base font-bold" key={index}>
              {inlineText(heading[2]!)}
            </h3>
          );
        }
        if (/^---+$/u.test(block.trim()))
          return <hr className="my-6 border-app-border" key={index} />;
        if (/^>\s/u.test(block)) {
          return (
            <blockquote className="my-4 border-l-4 border-role-border bg-role-soft p-4" key={index}>
              {inlineText(lines.map((line) => line.replace(/^>\s?/u, "")).join(" "))}
            </blockquote>
          );
        }
        if (/^(?:- |\d+\. )/u.test(block)) {
          const ordered = /^\d+\. /u.test(block);
          const items = block.split(ordered ? /\n(?=\d+\. )/u : /\n(?=- )/u);
          const children = items.map((item, itemIndex) => (
            <li key={itemIndex}>
              {inlineText(item.replace(/^(?:- |\d+\. )/u, "").replace(/\n\s*/gu, " "))}
            </li>
          ));
          return ordered ? (
            <ol className="my-4 list-decimal space-y-2 pl-5" key={index}>
              {children}
            </ol>
          ) : (
            <ul className="my-4 list-disc space-y-2 pl-5" key={index}>
              {children}
            </ul>
          );
        }
        return (
          <p className="my-4 whitespace-pre-wrap" key={index}>
            {inlineText(block)}
          </p>
        );
      })}
    </div>
  );
}
