import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PwaStatusController, type PwaRuntime, type PwaRuntimeEvent } from "./pwa-status";
import { PwaStatusBanner } from "./pwa-status-banner";

class BannerRuntime implements PwaRuntime {
  private readonly events = new EventTarget();

  constructor(public online: boolean) {}

  addEventListener(type: PwaRuntimeEvent, listener: EventListener): void {
    this.events.addEventListener(type, listener);
  }

  clearTimeout(): void {}

  getOnline(): boolean {
    return this.online;
  }

  getVisible(): boolean {
    return true;
  }

  reload(): void {}

  removeEventListener(type: PwaRuntimeEvent, listener: EventListener): void {
    this.events.removeEventListener(type, listener);
  }

  setTimeout(): number {
    return 1;
  }
}

describe("PwaStatusBanner", () => {
  it("does not claim an offline save succeeded", () => {
    const controller = new PwaStatusController();
    controller.start(() => vi.fn(async () => undefined), new BannerRuntime(false));

    render(<PwaStatusBanner controller={controller} />);

    expect(screen.getByRole("status", { name: "네트워크 연결 상태" })).toHaveTextContent(
      "저장이나 전송은 완료되지 않을 수 있어요",
    );
    expect(screen.queryByText(/저장(되었|됐)/u)).not.toBeInTheDocument();
    controller.destroy();
  });

  it("provides explicit update-now and later controls", () => {
    const controller = new PwaStatusController();
    controller.markUpdateAvailable();
    render(<PwaStatusBanner controller={controller} />);

    const applyButton = screen.getByRole("button", { name: "지금 새로고침" });
    const laterButton = screen.getByRole("button", { name: "나중에" });
    expect(applyButton).toHaveAttribute("type", "button");
    expect(applyButton).toHaveClass("ui-button");
    expect(laterButton).toHaveClass("ui-button");

    laterButton.focus();
    expect(laterButton).toHaveFocus();
    fireEvent.click(laterButton);
    expect(screen.queryByRole("status", { name: "앱 업데이트" })).not.toBeInTheDocument();

    controller.markUpdateAvailable();
    expect(screen.queryByRole("status", { name: "앱 업데이트" })).not.toBeInTheDocument();
  });

  it("warns that the screen will refresh while a new version downloads", () => {
    const snapshot = { ...new PwaStatusController().getSnapshot(), updateDownloading: true };
    const downloading = {
      getServerSnapshot: () => snapshot,
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
    } as unknown as PwaStatusController;
    render(<PwaStatusBanner controller={downloading} />);

    const banner = screen.getByRole("status", { name: "앱 업데이트" });
    expect(banner).toHaveTextContent("새 버전을 받고 있어요.");
    expect(banner).toHaveTextContent("곧 화면이 한 번 새로고침돼요");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
