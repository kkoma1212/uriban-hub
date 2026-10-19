import { afterEach, expect, it, vi } from "vitest";
import { openMariaDbOperatorDatabase } from "./operator-database.js";
const options = {
  host: "synthetic.example",
  database: "classhub",
  user: "classhub_operator",
  password: "synthetic",
  accountHost: "%",
  tls: "required" as const,
  sslCa: "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n",
  runtimeGrantProfile: "operator_commands_v1" as const,
  onRuntimeObservation: () => {},
};
afterEach(() => vi.useRealTimers());
it("opt-in normal operator opener bounds hung acquisition and closes its owned pool", async () => {
  vi.useFakeTimers();
  const end = vi.fn((callback: (error: Error | null) => void) => callback(null));
  const getConnection = vi.fn();
  const opening = openMariaDbOperatorDatabase(() => ({ getConnection, end }), options);
  const settled = opening.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(5001);
  expect(await settled).toMatchObject({ code: "MARIADB_RUNTIME_ROLE_ATTESTATION_FAILED" });
  expect(getConnection).toHaveBeenCalledOnce();
  expect(end).toHaveBeenCalledOnce();
});
it("bounds cleanup after hung acquisition even when underlying end never responds", async () => {
  vi.useFakeTimers();
  const end = vi.fn(),
    getConnection = vi.fn();
  const settled = openMariaDbOperatorDatabase(() => ({ getConnection, end }), options).then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(10002);
  expect(await settled).toMatchObject({ code: "MARIADB_RUNTIME_ROLE_ATTESTATION_FAILED" });
  expect(end).toHaveBeenCalledOnce();
});
