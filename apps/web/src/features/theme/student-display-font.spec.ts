import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureStudentDisplayFont, resetStudentDisplayFontForTests } from "./student-display-font";

describe("student display font loader", () => {
  afterEach(() => {
    resetStudentDisplayFontForTests();
  });

  it("loads the slice stylesheet once no matter how many student screens mount", () => {
    const load = vi.fn(() => Promise.resolve());

    ensureStudentDisplayFont(load);
    ensureStudentDisplayFont(load);
    ensureStudentDisplayFont(load);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("retries on the next student screen after a failed load", async () => {
    const failing = vi.fn(() => Promise.reject(new Error("chunk fetch failed")));
    ensureStudentDisplayFont(failing);
    await vi.waitFor(() => expect(failing).toHaveBeenCalledTimes(1));

    const succeeding = vi.fn(() => Promise.resolve());
    ensureStudentDisplayFont(succeeding);

    expect(succeeding).toHaveBeenCalledTimes(1);
  });
});
