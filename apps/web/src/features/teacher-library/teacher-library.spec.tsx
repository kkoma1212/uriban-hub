import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SaveToLibraryButton } from "./save-to-library-button";
import { TeacherLibraryPage } from "./teacher-library-page";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, status });
const url = (input: RequestInfo | URL): string =>
  String(input instanceof Request ? input.url : input);

const libraryItem = (id: string, extra: Record<string, unknown> = {}) => ({
  body: "범위는 1단원",
  category: "general",
  created_at: "2026-09-26T01:00:00.000000Z",
  id,
  is_important: false,
  kind: "notice",
  source: { academic_year: 2025, class_name: "1반", grade: 2, school_name: "합성 고등학교" },
  title: `자료 ${id}`,
  ...extra,
});

afterEach(() => vi.restoreAllMocks());
const withCsrfCookie = (): void => {
  vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
    "__Host-classhub_csrf=test-csrf-token",
  );
};

describe("teacher library (S2)", () => {
  it("shows detected personal info and saves only after the teacher confirms", async () => {
    const posted: Array<{ path: string; body: unknown }> = [];
    withCsrfCookie();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = url(input);
      if (path.includes("/csrf")) return json({ csrf_token: "token" });
      if (init?.method === "POST") posted.push({ path, body: JSON.parse(String(init.body)) });
      if (path.endsWith("/teacher-library/check"))
        return json({
          hits:
            posted.length === 1
              ? [
                  { kind: "name", text: "김민수" },
                  { kind: "phone", text: "010-1234-5678" },
                ]
              : [],
        });
      if (path.endsWith("/teacher-library")) return json(libraryItem("7"));
      return json({});
    });
    render(
      <MemoryRouter>
        <SaveToLibraryButton body="김민수 010-1234-5678" kind="notice" sourceId="10" title="안내" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "자료함에 담기" }));
    const dialog = await screen.findByRole("dialog", { name: "자료함에 담기" });
    const hits = await within(dialog).findByRole("list", { name: "찾은 개인정보" });
    expect(hits).toHaveTextContent("김민수");
    expect(hits).toHaveTextContent("010-1234-5678");
    const save = within(dialog).getAllByRole("button", { name: "자료함에 담기" }).at(-1)!;
    expect(save).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("내용"), { target: { value: "범위는 1단원" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /고친 내용 다시 확인/u }));
    expect(await within(dialog).findByText(/모양을 찾지 못했어요/u)).toBeVisible();
    expect(save).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /개인정보가 없음을 확인/u }));
    fireEvent.click(save);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "자료함에 담음" })).toBeDisabled(),
    );
    expect(posted.at(-1)).toEqual({
      path: "/api/v1/teacher-library",
      body: {
        body: "범위는 1단원",
        confirm_personal_info: true,
        kind: "notice",
        source_id: "10",
        title: "안내",
      },
    });
  });

  it("lists saved items with a reuse link for notices and homework and deletes after confirm", async () => {
    const deleted: string[] = [];
    withCsrfCookie();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = url(input);
      if (path.includes("/csrf")) return json({ csrf_token: "token" });
      if (init?.method === "DELETE") {
        deleted.push(path);
        return new Response(null, { status: 204 });
      }
      return json({
        items: [
          libraryItem("1"),
          libraryItem("2", { kind: "supply", category: "homework", title: "숙제 자료" }),
          libraryItem("3", { kind: "supply", category: "general", title: "준비물 자료" }),
        ],
        next_cursor: null,
      });
    });
    render(
      <MemoryRouter>
        <TeacherLibraryPage />
      </MemoryRouter>,
    );
    const list = await screen.findByRole("list", { name: "자료 목록" });
    const reuse = within(list).getAllByRole("link", { name: /이 자료로 새 글 쓰기/u });
    expect(reuse.map((link) => link.getAttribute("href"))).toEqual([
      "/updates/reuse/notice/1?from=library",
      "/updates/reuse/homework/2?from=library",
    ]);
    fireEvent.click(within(list).getAllByRole("button", { name: /지우기/u })[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "지우기" }));
    await waitFor(() => expect(deleted).toEqual(["/api/v1/teacher-library/1"]));
    await waitFor(() => expect(within(list).queryByText("자료 1")).not.toBeInTheDocument());
  });
});
