import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClassRecordsDownload } from "./class-records-download";

const url = (input: RequestInfo | URL): string =>
  String(input instanceof Request ? input.url : input);

function renderDownload(pastClassId?: string) {
  return render(
    <MemoryRouter initialEntries={["/class/archive"]}>
      <Routes>
        <Route
          element={<ClassRecordsDownload {...(pastClassId ? { pastClassId } : {})} />}
          path="/class/archive"
        />
        <Route element={<p>로그인 화면</p>} path="/login" />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("ClassRecordsDownload", () => {
  it("지금 반 기록을 받아 날짜가 붙은 CSV 파일로 내려받게 한다", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response('\uFEFF"종류"\r\n', { headers: { "Content-Type": "text/csv" } }),
      );
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation(() => "blob:class-records");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });
    renderDownload();
    const button = screen.getByRole("button", { name: "반 기록 CSV 받기" });
    expect(button).toHaveAccessibleDescription(/학생 이름과 확인 현황은 들어가지 않아요/u);
    fireEvent.click(button);
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(url(fetchMock.mock.calls[0]![0])).toBe("/api/v1/classes/current/records.csv");
    expect(downloads[0]).toMatch(/^반-기록-\d{4}-\d{2}-\d{2}\.csv$/u);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(button).toBeEnabled();
  });

  it("받지 못하면 서버 안내를 보여 주고, 로그인이 끝났으면 로그인 화면으로 보낸다", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "ROLE_INSUFFICIENT",
            message: "반 기록은 이 반의 선생님만 내려받을 수 있어요.",
          },
        }),
        { headers: { "Content-Type": "application/json" }, status: 403 },
      ),
    );
    renderDownload("12");
    fireEvent.click(screen.getByRole("button", { name: "반 기록 CSV 받기" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "반 기록은 이 반의 선생님만 내려받을 수 있어요.",
    );
    expect(url(fetchMock.mock.calls[0]![0])).toBe("/api/v1/past-classes/12/records.csv");

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "로그인 필요" } }), {
        headers: { "Content-Type": "application/json" },
        status: 401,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "반 기록 CSV 받기" }));
    expect(await screen.findByText("로그인 화면")).toBeVisible();
  });
});
