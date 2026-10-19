import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { ShieldCheck } from "lucide-react";
import type { AdminSessionResponse } from "../../api/admin-auth";
import { AdminWorkspace } from "./admin-workspace";
vi.mock("./admin-session-status", () => ({ AdminSessionStatus: () => null }));
vi.mock("./admin-step-up-dialog", () => ({ AdminStepUpDialog: () => null }));
const session = {
  account: { id: "17", roles: ["super_admin"], display_name: "관리자" },
  session: { issued_at: "now" },
} as AdminSessionResponse;
let wide = false;
const change = new Set<() => void>();
const props = {
  activeId: "inquiries",
  groups: [
    {
      label: "업무",
      items: [
        { id: "overview", label: "한눈에 보기", icon: ShieldCheck },
        { id: "inquiries", label: "문의", icon: ShieldCheck },
      ],
    },
  ],
  session,
  loggingOut: false,
  onLogout: vi.fn(),
  onSelect: vi.fn(),
  onSessionChange: vi.fn(),
  children: <button>본문 조작</button>,
};
const menu = () => document.querySelector<HTMLButtonElement>(".admin-topbar-button")!;
const setup = () =>
  render(
    <MemoryRouter>
      <AdminWorkspace {...props} />
    </MemoryRouter>,
  );
const resize = async (value: boolean) => {
  wide = value;
  await act(async () => {
    for (const fn of change) fn();
  });
};
beforeEach(() => {
  wide = false;
  change.clear();
  props.onSelect.mockReset();
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return wide;
    },
    addEventListener: (_name: string, fn: () => void) => change.add(fn),
    removeEventListener: (_name: string, fn: () => void) => change.delete(fn),
  }));
});
afterEach(() => vi.unstubAllGlobals());
describe("AdminWorkspace mobile drawer", () => {
  it("moves through authorized tabs with arrows and Home/End without selecting a panel", () => {
    setup();
    fireEvent.click(menu());
    const overview = screen.getByRole("tab", { name: "한눈에 보기" });
    const inquiries = screen.getByRole("tab", { name: "문의" });
    expect(inquiries.tabIndex).toBe(0);
    expect(overview.tabIndex).toBe(-1);
    fireEvent.keyDown(inquiries, { key: "ArrowDown" });
    expect(overview).toHaveFocus();
    expect(overview.tabIndex).toBe(0);
    expect(inquiries.tabIndex).toBe(-1);
    expect(inquiries).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(overview, { key: "ArrowUp" });
    expect(inquiries).toHaveFocus();
    fireEvent.keyDown(inquiries, { key: "Home" });
    expect(overview).toHaveFocus();
    fireEvent.keyDown(overview, { key: "End" });
    expect(inquiries).toHaveFocus();
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(menu()).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(menu());
    expect(inquiries).toHaveFocus();
    expect(inquiries.tabIndex).toBe(0);
  });
  it("keeps one keyboard entry when permissions or the active panel change", () => {
    wide = true;
    const view = setup();
    const overview = screen.getByRole("tab", { name: "한눈에 보기" });
    fireEvent.focus(overview);
    view.rerender(
      <MemoryRouter>
        <AdminWorkspace {...props} activeId="overview" />
      </MemoryRouter>,
    );
    expect(overview.tabIndex).toBe(0);
    view.rerender(
      <MemoryRouter>
        <AdminWorkspace
          {...props}
          groups={[{ label: "업무", items: [props.groups[0]!.items[1]!] }]}
        />
      </MemoryRouter>,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.tabIndex).toBe(0);
    expect(tabs[0]).toHaveAccessibleName("문의");
  });
  it("opens on the selected tab rather than the first and close returns to the trigger", () => {
    setup();
    fireEvent.click(menu());
    expect(screen.getByRole("tab", { name: "문의" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "관리자 메뉴 닫기" }));
    expect(menu()).toHaveFocus();
    expect(menu()).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("admin-sidebar")).toHaveAttribute("inert");
  });
  it("isolates the mobile background and restores its semantics on close", () => {
    setup();
    fireEvent.click(menu());
    expect(screen.getByRole("dialog", { name: "관리자 메뉴" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    expect(screen.queryByRole("button", { name: "본문 조작" })).not.toBeInTheDocument();
    expect(document.querySelector(".admin-body")).toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("button", { name: "관리자 메뉴 닫기" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "관리자 메뉴" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "본문 조작" })).toBeInTheDocument();
    expect(document.querySelector(".admin-body")).not.toHaveAttribute("inert");
  });
  it("falls back to the first tab when the current tab is unavailable", () => {
    render(
      <MemoryRouter>
        <AdminWorkspace {...props} activeId={undefined} />
      </MemoryRouter>,
    );
    fireEvent.click(menu());
    expect(screen.getByRole("tab", { name: "한눈에 보기" })).toHaveFocus();
  });
  it("falls back to the close control when no authorized tabs exist", () => {
    render(
      <MemoryRouter>
        <AdminWorkspace {...props} groups={[]} />
      </MemoryRouter>,
    );
    fireEvent.click(menu());
    expect(screen.getByRole("button", { name: "관리자 메뉴 닫기" })).toHaveFocus();
  });
  it("clears the account dropdown on drawer open", () => {
    setup();
    document.querySelector("details")!.setAttribute("open", "");
    fireEvent.click(menu());
    expect(document.querySelector("details")).not.toHaveAttribute("open");
  });
  it("Escape closes and removes the focus trap", () => {
    setup();
    fireEvent.click(menu());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(menu()).toHaveFocus();
    const e = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
  it("wraps Tab only through visible enabled controls and ignores hidden or disabled tails", () => {
    setup();
    fireEvent.click(menu());
    const sidebar = document.getElementById("admin-sidebar")!;
    const tail = screen.getByRole("tab", { name: "문의" });
    const disabled = document.createElement("button");
    disabled.disabled = true;
    sidebar.append(disabled);
    const hidden = document.createElement("button");
    hidden.hidden = true;
    sidebar.append(hidden);
    tail.focus();
    const e = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(screen.getByRole("link", { name: /우리반 허브/ })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(tail).toHaveFocus();
  });
  it("desktop resize resets the drawer and frees keyboard navigation without focusing a hidden trigger", async () => {
    setup();
    fireEvent.click(menu());
    screen.getByRole("button", { name: "관리자 메뉴 닫기" }).focus();
    await resize(true);
    expect(screen.queryByRole("button", { name: "관리자 메뉴 닫기" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "문의" })).toHaveFocus();
    expect(document.querySelector("[data-drawer-open]")).toHaveAttribute(
      "data-drawer-open",
      "false",
    );
    const e = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    await resize(false);
    expect(menu()).toHaveFocus();
    expect(menu()).toHaveAttribute("aria-expanded", "false");
  });
  it("selection closes before the parent guard so cancellation can return to a visible trigger", () => {
    props.onSelect.mockImplementation(() => {
      expect(menu()).toHaveFocus();
      expect(document.querySelector(".admin-body")).not.toHaveAttribute("inert");
    });
    setup();
    fireEvent.click(menu());
    fireEvent.click(screen.getByRole("tab", { name: "한눈에 보기" }));
    expect(props.onSelect).toHaveBeenCalledWith("overview");
    expect(menu()).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(menu());
    expect(screen.getByRole("tab", { name: "문의" })).toHaveFocus();
  });
  it("does not steal Tab or Escape from a higher confirmation dialog", () => {
    setup();
    fireEvent.click(menu());
    document.getElementById("admin-sidebar")!.setAttribute("inert", "");
    const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(menu()).toHaveAttribute("aria-expanded", "true");
  });
});

describe("관리자 회원 검색 안내", () => {
  it("짧은 검색어를 안내하고 수정한 검색어는 앞뒤 공백을 제거해 전달한다", () => {
    wide = true;
    const onSearch = vi.fn();
    render(
      <MemoryRouter>
        <AdminWorkspace {...props} onSearch={onSearch} />
      </MemoryRouter>,
    );
    const input = screen.getByRole("searchbox", { name: "회원 검색" });
    expect(input).toHaveAccessibleDescription(
      "회원 이메일이나 이름을 앞뒤 공백을 제외하고 2자 이상 입력해 주세요.",
    );
    fireEvent.change(input, { target: { value: " 김 " } });
    fireEvent.submit(screen.getByRole("search"));
    expect(onSearch).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "회원 이메일이나 이름을 2자 이상 입력해 주세요.",
    );
    expect(input).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(input, { target: { value: " 김민 " } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-invalid");
    fireEvent.submit(screen.getByRole("search"));
    expect(onSearch).toHaveBeenCalledExactlyOnceWith("김민");
  });
  it("검색 권한이 없으면 검색창과 검색 안내를 제공하지 않는다", () => {
    wide = true;
    setup();
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(
      screen.queryByText("회원 이메일이나 이름을 앞뒤 공백을 제외하고 2자 이상 입력해 주세요."),
    ).not.toBeInTheDocument();
  });
});
