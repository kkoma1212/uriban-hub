import { describe, expect, it, vi } from "vitest";
import {
  runtimeInspectionHoldMs,
  hasRuntimeObservationSettings,
  holdRuntimeObservationForInspection,
} from "./runtime-inspection-window.js";
import { createConfiguredRuntimeObservation } from "./configured-runtime-observation.js";
const env = {
  CLASSHUB_RUNTIME_OBSERVATION_DIRECTORY: "/private/proofs",
  CLASSHUB_RUNTIME_OBSERVATION_CHALLENGE: "a".repeat(64),
};
describe("bounded diagnostic CLI process window", () => {
  it("default performs no waiting and no opt-in", async () => {
    const schedule = vi.fn();
    expect(runtimeInspectionHoldMs({})).toBe(0);
    expect(hasRuntimeObservationSettings({})).toBe(false);
    await holdRuntimeObservationForInspection(0, schedule);
    expect(schedule).not.toHaveBeenCalled();
  });
  it.each(["0", "1", "60000"])(
    "accepts canonical milliseconds %s only with observation settings",
    (value) => {
      expect(runtimeInspectionHoldMs({ ...env, CLASSHUB_RUNTIME_OBSERVATION_HOLD_MS: value })).toBe(
        Number(value),
      );
    },
  );
  it.each(["", " 1", "1 ", "01", "+1", "1e3", "1.5", "-1", "60001", "999999", "NaN", 1, null])(
    "rejects invalid hold %s",
    (value) => {
      expect(() =>
        runtimeInspectionHoldMs({ ...env, CLASSHUB_RUNTIME_OBSERVATION_HOLD_MS: value }),
      ).toThrow("MariaDB runtime observation failed.");
    },
  );
  it("hold-only is an opt-in setting but cannot open a partial diagnostic", () => {
    const holdOnly = { CLASSHUB_RUNTIME_OBSERVATION_HOLD_MS: "1" };
    expect(hasRuntimeObservationSettings(holdOnly)).toBe(true);
    expect(() => runtimeInspectionHoldMs(holdOnly)).toThrow();
    expect(() => createConfiguredRuntimeObservation("operator", holdOnly)).toThrow();
  });
  it.each(["user-api", "admin-api", "worker"] as const)(
    "rejects CLI hold on %s before filesystem access",
    (component) => {
      const getuid = vi.fn();
      expect(() =>
        createConfiguredRuntimeObservation(
          component,
          { ...env, CLASSHUB_RUNTIME_OBSERVATION_HOLD_MS: "1" },
          { getuid },
        ),
      ).toThrow();
      expect(getuid).not.toHaveBeenCalled();
    },
  );
  it("does not finish until its bounded window completes and masks scheduler errors", async () => {
    let finish!: () => void;
    const schedule = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let complete = false;
    const waiting = holdRuntimeObservationForInspection(60_000, schedule).then(() => {
      complete = true;
    });
    expect(schedule).toHaveBeenCalledExactlyOnceWith(60_000);
    expect(complete).toBe(false);
    finish();
    await waiting;
    expect(complete).toBe(true);
    await expect(
      holdRuntimeObservationForInspection(1, async () => {
        throw new Error("private scheduler");
      }),
    ).rejects.toThrow("MariaDB runtime observation failed.");
  });
  it.each([-1, 60_001, Infinity, 1.5])(
    "rejects invalid direct scheduler duration %s",
    async (value) => {
      const schedule = vi.fn();
      await expect(holdRuntimeObservationForInspection(value, schedule)).rejects.toThrow();
      expect(schedule).not.toHaveBeenCalled();
    },
  );
});
