import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemStateBanner } from "./system-state-banner";
// 공통 시험 설정(src/test/setup.ts)이 다른 화면 시험을 위해 빈 칸으로 바꾼 것을 여기서만 되돌린다.
vi.unmock("./system-state-banner");
const reply = (data: unknown) => ({ ok: true, json: async () => data }) as Response;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("public shell announcement and maintenance", () => {
  it("renders announcement as plain text and keeps an existing input through ON/OFF", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply({ maintenance: true, announcement: "<b>공지</b>" }))
      .mockResolvedValueOnce(reply({ maintenance: false, announcement: null }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <>
        <SystemStateBanner />
        <label>
          작성 내용
          <input defaultValue="보존할 내용" />
        </label>
      </>,
    );
    expect(await screen.findByText("<b>공지</b>")).toBeVisible();
    expect(document.querySelector("b")).toBeNull();
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "작성 내용" })).toHaveValue("보존할 내용");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      credentials: "omit",
      cache: "no-store",
    });
  });
  it("hides stale announcement when state read fails and never claims normal status", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(reply({ maintenance: false, announcement: "이전 공지" }))
        .mockRejectedValueOnce(new Error("offline")),
    );
    render(<SystemStateBanner />);
    expect(await screen.findByText("이전 공지")).toBeVisible();
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(screen.queryByText("이전 공지")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("정상 이용 여부는 확인되지 않았습니다");
  });
  it("ignores a late response after a newer focus refresh", async () => {
    let finish: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              finish = resolve;
            }),
        )
        .mockResolvedValueOnce(reply({ maintenance: false, announcement: "최신 공지" })),
    );
    render(<SystemStateBanner />);
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(screen.getByText("최신 공지")).toBeVisible();
    await act(async () => {
      finish(reply({ maintenance: true, announcement: "과거 공지" }));
    });
    expect(screen.queryByText("과거 공지")).not.toBeInTheDocument();
    expect(screen.getByText("최신 공지")).toBeVisible();
  });
});

it("pauses hidden/offline polling, refreshes on return, and stops after unmount", async () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = "visible";
  let online = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  const fetchMock = vi.fn().mockResolvedValue(reply({ maintenance: false, announcement: null }));
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<SystemStateBanner />);
  await act(async () => undefined);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  visibility = "hidden";
  await act(async () => {
    fireEvent(document, new Event("visibilitychange"));
    vi.advanceTimersByTime(30000);
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  visibility = "visible";
  await act(async () => {
    fireEvent(document, new Event("visibilitychange"));
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  online = false;
  await act(async () => {
    fireEvent(window, new Event("offline"));
    vi.advanceTimersByTime(30000);
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("alert")).toHaveTextContent("점검 상태를 확인하지 못했어요");
  online = true;
  await act(async () => {
    fireEvent(window, new Event("online"));
  });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  view.unmount();
  await act(async () => {
    vi.advanceTimersByTime(30000);
  });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("discards a previous route or role response without remounting the input", async () => {
  let finish: (response: Response) => void = () => undefined;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(reply({ maintenance: false, announcement: "새 화면 공지" })),
  );
  const content = (key: string) => (
    <>
      <SystemStateBanner key={key} />
      <input aria-label="작성 내용" defaultValue="초안" />
    </>
  );
  const view = render(content("student:/home"));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "진행 중 초안" },
  });
  await act(async () => {
    view.rerender(content("teacher:/updates"));
  });
  expect(screen.getByText("새 화면 공지")).toBeVisible();
  await act(async () => {
    finish(reply({ maintenance: true, announcement: "이전 화면 공지" }));
  });
  expect(screen.queryByText("이전 화면 공지")).not.toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveValue("진행 중 초안");
});
