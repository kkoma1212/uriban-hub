import { describe, expect, it } from "vitest";

import { recordServerResponseStatus, serverErrorsInLastHour } from "./server-error-window.js";

describe("server error window", () => {
  it("5xx만 세고 1시간이 지난 오류는 빠진다", () => {
    const start = Date.UTC(2026, 8, 28, 3, 0, 0);
    const before = serverErrorsInLastHour(start);
    recordServerResponseStatus(200, start);
    recordServerResponseStatus(404, start);
    recordServerResponseStatus(500, start);
    recordServerResponseStatus(503, start + 30 * 60 * 1000);
    expect(serverErrorsInLastHour(start + 30 * 60 * 1000)).toBe(before + 2);
    expect(serverErrorsInLastHour(start + 61 * 60 * 1000)).toBe(1);
    expect(serverErrorsInLastHour(start + 91 * 60 * 1000)).toBe(0);
  });
});
