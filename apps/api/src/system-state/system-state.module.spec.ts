import { describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@nestjs/common";
import { MaintenanceMutationGuard, PublicSystemStateService } from "./system-state.module.js";
import type { ClassHubDatabase } from "../database/database.module.js";

const context = (method: string, route: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ method, routeOptions: { url: route }, url: route }),
    }),
  }) as ExecutionContext;
const service = (execute: () => Promise<unknown>) =>
  new PublicSystemStateService({
    selectFrom: () => ({ select: () => ({ where: () => ({ execute }) }) }),
  } as unknown as ClassHubDatabase);

describe("fresh cross-process server policy", () => {
  it("observes ON then OFF without retaining a stale write allowance", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ key: "maintenance_mode", value_json: { enabled: true } }])
      .mockResolvedValueOnce([{ key: "maintenance_mode", value_json: { enabled: false } }]);
    const guard = new MaintenanceMutationGuard(service(execute));
    await expect(guard.canActivate(context("POST", "/api/v1/notices"))).rejects.toMatchObject({
      response: { code: "MAINTENANCE_MODE" },
      status: 503,
    });
    await expect(guard.canActivate(context("POST", "/api/v1/notices"))).resolves.toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("fails closed on uncertain business state but preserves recovery without querying state", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("private db details"));
    const guard = new MaintenanceMutationGuard(service(execute));
    await expect(guard.canActivate(context("POST", "/api/v1/notices"))).rejects.toMatchObject({
      response: { code: "SYSTEM_STATE_UNAVAILABLE" },
      status: 503,
    });
    for (const [method, route] of [
      ["GET", "/api/v1/notices"],
      ["POST", "/api/v1/auth/logout"],
      ["POST", "/api/v1/account/deletion"],
      ["PATCH", "/api/v1/admin/system-state/maintenance_mode"],
    ])
      await expect(guard.canActivate(context(method!, route!))).resolves.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });
});

it("installed Nest guard refusal reaches neither interceptor nor handler", async () => {
  const { RouterExecutionContext } =
    await import("@nestjs/core/router/router-execution-context.js");
  const { GuardsConsumer } = await import("@nestjs/core/guards/guards-consumer.js");
  const { RequestMethod } = await import("@nestjs/common");
  const execute = vi
    .fn()
    .mockResolvedValue([{ key: "maintenance_mode", value_json: { enabled: true } }]);
  const guard = new MaintenanceMutationGuard(service(execute));
  const handler = vi.fn();
  const interceptor = vi.fn();
  const router = new RouterExecutionContext(
    {} as never,
    { create: () => [] } as never,
    {} as never,
    { create: () => [guard] } as never,
    new GuardsConsumer(),
    { create: () => [] } as never,
    { intercept: interceptor } as never,
    { status: vi.fn() } as never,
  );
  vi.spyOn(router, "getMetadata").mockReturnValue({
    argsLength: 0,
    fnHandleResponse: vi.fn(),
    isSseHandler: false,
    paramtypes: [],
    getParamsMetadata: () => [],
    httpStatusCode: 200,
    responseHeaders: [],
    hasCustomHeaders: false,
  } as never);
  const pipeline = router.create({}, handler, "save", "isolated", RequestMethod.POST);
  await expect(
    pipeline(
      {
        method: "POST",
        routeOptions: { url: "/api/v1/notices" },
        url: "/api/v1/notices",
      },
      {},
      () => undefined,
    ),
  ).rejects.toMatchObject({
    response: { code: "MAINTENANCE_MODE" },
    status: 503,
  });
  expect(interceptor).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
});
