import { setTimeout as delay } from "node:timers/promises";
import { MariaDbRuntimeObservationError } from "./runtime-observation.js";

/** A bounded diagnostic window after the CLI closes its DB pool. Never an admission. */
export function runtimeInspectionHoldMs(environment: Readonly<Record<string, unknown>>): number {
  const value = environment.CLASSHUB_RUNTIME_OBSERVATION_HOLD_MS;
  if (value === undefined) return 0;
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]{0,4})$/.test(value) ||
    Number(value) > 60_000 ||
    typeof environment.CLASSHUB_RUNTIME_OBSERVATION_DIRECTORY !== "string" ||
    !environment.CLASSHUB_RUNTIME_OBSERVATION_DIRECTORY ||
    typeof environment.CLASSHUB_RUNTIME_OBSERVATION_CHALLENGE !== "string" ||
    !/^[a-f0-9]{64}$/.test(environment.CLASSHUB_RUNTIME_OBSERVATION_CHALLENGE)
  )
    throw new MariaDbRuntimeObservationError();
  return Number(value);
}

export function hasRuntimeObservationSettings(
  environment: Readonly<Record<string, unknown>>,
): boolean {
  return [
    "CLASSHUB_RUNTIME_OBSERVATION_DIRECTORY",
    "CLASSHUB_RUNTIME_OBSERVATION_CHALLENGE",
    "CLASSHUB_RUNTIME_OBSERVATION_HOLD_MS",
  ].some((key) => environment[key] !== undefined);
}

export async function holdRuntimeObservationForInspection(
  milliseconds: number,
  schedule: (milliseconds: number) => Promise<unknown> = delay,
): Promise<void> {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 60_000) {
    throw new MariaDbRuntimeObservationError();
  }
  if (milliseconds === 0) return;
  try {
    await schedule(milliseconds);
  } catch {
    throw new MariaDbRuntimeObservationError();
  }
}
