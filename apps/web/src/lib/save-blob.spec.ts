import { afterEach, describe, expect, it, vi } from "vitest";

import { saveBlobAsFile } from "./save-blob";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("saveBlobAsFile", () => {
  it("문서에 붙인 링크를 눌러 받고, 링크는 떼고, 주소는 10초 뒤에 지운다", () => {
    vi.useFakeTimers();
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:saved");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const clicks: Array<{ connected: boolean; download: string; href: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push({ connected: this.isConnected, download: this.download, href: this.href });
    });

    saveBlobAsFile(new Blob(["a"]), "반-기록.csv");

    expect(clicks).toEqual([{ connected: true, download: "반-기록.csv", href: "blob:saved" }]);
    expect(document.querySelector("a[download]")).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(revoke).toHaveBeenCalledWith("blob:saved");
  });
});
