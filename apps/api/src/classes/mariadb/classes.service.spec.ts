import { ConfigService } from "@nestjs/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const callers = vi.hoisted(() => ({
  create: vi.fn(),
  archiveCurrent: vi.fn(),
  getCurrent: vi.fn(),
  updateCurrent: vi.fn(),
  getCurrentInviteCode: vi.fn(),
  rotateInviteCode: vi.fn(),
}));
vi.mock("./create-class.js", () => ({ createClassMariaDb: callers.create }));
vi.mock("./archive-class.js", () => ({ archiveCurrentClassMariaDb: callers.archiveCurrent }));
vi.mock("./current-class.js", () => ({
  getCurrentClassMariaDb: callers.getCurrent,
  updateCurrentClassMariaDb: callers.updateCurrent,
}));
vi.mock("./invite-code.js", () => ({
  getCurrentInviteCodeMariaDb: callers.getCurrentInviteCode,
  rotateInviteCodeMariaDb: callers.rotateInviteCode,
}));

import type { AppEnvironment } from "../../config/environment.js";
import type { ClassHubDatabase } from "../../database/database.module.js";
import { createClassesService } from "../classes.module.js";
import { ClassesService } from "../classes.service.js";
import { MariaDbClassesService } from "./classes.service.js";

function select(engine?: string) {
  const database = {} as ClassHubDatabase;
  const config = new ConfigService<AppEnvironment, true>(
    engine === undefined ? {} : { DATABASE_ENGINE: engine },
  );
  return {
    database,
    service: createClassesService(database, config),
  };
}

beforeEach(() => {
  for (const caller of Object.values(callers)) caller.mockReset();
});

describe("ClassesService database provider", () => {
  it("selects Maria explicitly and preserves the PG default only for unchanged configurations", () => {
    expect(select("mariadb").service).toBeInstanceOf(MariaDbClassesService);
    expect(Object.getPrototypeOf(select("postgres").service)).toBe(ClassesService.prototype);
    expect(Object.getPrototypeOf(select().service)).toBe(ClassesService.prototype);
    expect(() => select("unsupported")).toThrow("Unsupported database engine");
  });

  it("overrides every public PG operation so no class endpoint inherits a PG query path", async () => {
    const { database, service } = select("mariadb");
    const publicMethods = Object.getOwnPropertyNames(ClassesService.prototype).filter(
      (name) => name !== "constructor" && name !== "getTeacherContext",
    );
    expect(publicMethods.sort()).toEqual(Object.keys(callers).sort());
    for (const name of publicMethods) {
      expect(Object.hasOwn(MariaDbClassesService.prototype, name)).toBe(true);
    }
    const payload = { actorUserId: "9007199254740993", requestId: "preserved-request" };
    const now = new Date("2026-09-07T00:00:00.123Z");
    const output = { marker: "reviewed Maria caller result" };
    for (const caller of Object.values(callers)) caller.mockResolvedValue(output);

    await expect(service.create(payload as never)).resolves.toBe(output);
    await expect(service.archiveCurrent(payload as never)).resolves.toBe(output);
    await expect(service.getCurrent(payload.actorUserId)).resolves.toBe(output);
    await expect(service.updateCurrent(payload as never)).resolves.toBe(output);
    await expect(service.getCurrentInviteCode(payload.actorUserId, now)).resolves.toBe(output);
    await expect(service.rotateInviteCode(payload as never)).resolves.toBe(output);

    for (const name of ["create", "archiveCurrent", "updateCurrent", "rotateInviteCode"] as const) {
      expect(callers[name]).toHaveBeenCalledExactlyOnceWith(database, payload);
    }
    expect(callers.getCurrent).toHaveBeenCalledExactlyOnceWith(database, payload.actorUserId);
    expect(callers.getCurrentInviteCode).toHaveBeenCalledExactlyOnceWith(
      database,
      payload.actorUserId,
      now,
    );
  });

  it("propagates a reviewed caller rejection without retrying or entering the PG implementation", async () => {
    const { service } = select("mariadb");
    const failure = new Error("synthetic reviewed caller rejection");
    callers.archiveCurrent.mockRejectedValue(failure);
    await expect(service.archiveCurrent({} as never)).rejects.toBe(failure);
    expect(callers.archiveCurrent).toHaveBeenCalledOnce();
  });
});
