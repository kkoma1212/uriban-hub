import * as nativeFs from "node:fs";
import { runtimeInspectionHoldMs } from "./runtime-inspection-window.js";
import { posix } from "node:path";
const { isAbsolute, dirname, join, normalize } = posix;
import { randomUUID } from "node:crypto";
import { isSupportedMariaDbServerVersion } from "./runtime-role.js";
import {
  MariaDbRuntimeObservationError,
  type MariaDbRuntimeObservationSink,
} from "./runtime-observation.js";
export type MariaDbRuntimeObservationComponent =
  "user-api" | "admin-api" | "worker" | "retention" | "operator";
type FileIdentity = Pick<
  nativeFs.Stats,
  "uid" | "mode" | "dev" | "ino" | "nlink" | "isDirectory" | "isFile" | "isSymbolicLink"
>;
export interface RuntimeObservationFileSystem {
  lstatSync(path: string): FileIdentity;
  fstatSync(fd: number): FileIdentity;
  openSync(path: string, flags: number, mode?: number): number;
  writeSync(fd: number, data: Buffer, offset: number, length: number): number;
  readSync(fd: number, data: Buffer, offset: number, length: number, position: number): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  linkSync(source: string, target: string): void;
  unlinkSync(path: string): void;
}
export interface RuntimeObservationDependencies {
  fs: RuntimeObservationFileSystem;
  platform: string;
  getuid: () => number;
  pid: number;
  now: () => number;
  randomUUID: () => string;
}
export interface ConfiguredRuntimeObservation {
  readonly sink: MariaDbRuntimeObservationSink;
  assertCaptured(): void;
}
const roles = {
  "user-api": "app",
  "admin-api": "app",
  worker: "worker",
  retention: "retention",
  operator: "operator",
} as const;
const keys = [
  "schemaVersion",
  "role",
  "serverVersion",
  "tlsVersion",
  "verifiedTls",
  "accountIdentitySha256",
  "databaseIdentitySha256",
  "sessionIdentitySha256",
  "observedAt",
];
function fail(): never {
  throw new MariaDbRuntimeObservationError();
}
const same = (a: FileIdentity, b: FileIdentity) => a.dev === b.dev && a.ino === b.ino;
function instant(value: unknown): number {
  if (typeof value !== "string") return fail();
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time <= 0 || new Date(time).toISOString() !== value) return fail();
  return time;
}
/** Linux-only opt-in private record. PID is process-local, never host/image provenance.
 * No directory FD is retained when DB startup fails or no observation arrives. */
export function createConfiguredRuntimeObservation(
  component: MariaDbRuntimeObservationComponent,
  environment: Record<string, unknown>,
  injected: Partial<RuntimeObservationDependencies> = {},
): ConfiguredRuntimeObservation | undefined {
  const directory = environment.CLASSHUB_RUNTIME_OBSERVATION_DIRECTORY;
  const challenge = environment.CLASSHUB_RUNTIME_OBSERVATION_CHALLENGE;
  const inspectionHold = environment.CLASSHUB_RUNTIME_OBSERVATION_HOLD_MS;
  if (directory === undefined && challenge === undefined && inspectionHold === undefined)
    return undefined;
  try {
    if (inspectionHold !== undefined) {
      if (component !== "retention" && component !== "operator") fail();
      runtimeInspectionHoldMs(environment);
    }
    if (
      !Object.hasOwn(roles, component) ||
      typeof directory !== "string" ||
      directory !== directory.trim() ||
      !isAbsolute(directory) ||
      normalize(directory) !== directory ||
      directory === "/" ||
      directory.endsWith("/") ||
      /[\\\u0000-\u001f\u007f]/.test(directory) ||
      typeof challenge !== "string" ||
      !/^[a-f0-9]{64}$/.test(challenge)
    )
      fail();
    const deps: RuntimeObservationDependencies = {
      fs: nativeFs,
      platform: process.platform,
      getuid: () => process.getuid!(),
      pid: process.pid,
      now: Date.now,
      randomUUID,
      ...injected,
    };
    if (deps.platform !== "linux" || typeof deps.getuid !== "function") fail();
    const uid = deps.getuid(),
      started = deps.now(),
      bootId = deps.randomUUID();
    if (
      !Number.isSafeInteger(uid) ||
      uid < 0 ||
      !Number.isSafeInteger(deps.pid) ||
      deps.pid <= 0 ||
      !Number.isSafeInteger(started) ||
      started <= 0 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(bootId)
    )
      fail();
    let ancestor = directory;
    while (true) {
      if (deps.fs.lstatSync(ancestor).isSymbolicLink()) fail();
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const initial = deps.fs.lstatSync(directory);
    const directoryValid = (stat: FileIdentity) =>
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === uid &&
      (stat.mode & 0o7777) === 0o700;
    if (!directoryValid(initial)) fail();
    let captured = false;
    let saved: { filename: string; identity: FileIdentity; data: Buffer } | undefined;
    const assertCaptured = () => {
      let directoryFd: number | undefined, fileFd: number | undefined;
      try {
        if (!captured || !saved) fail();
        directoryFd = deps.fs.openSync(
          directory,
          nativeFs.constants.O_RDONLY |
            nativeFs.constants.O_DIRECTORY |
            nativeFs.constants.O_NOFOLLOW,
        );
        const pinned = deps.fs.fstatSync(directoryFd);
        if (
          !directoryValid(pinned) ||
          !same(initial, pinned) ||
          !same(deps.fs.lstatSync(directory), pinned)
        )
          fail();
        const path = join("/proc/self/fd/" + directoryFd, saved.filename);
        fileFd = deps.fs.openSync(
          path,
          nativeFs.constants.O_RDONLY | nativeFs.constants.O_NOFOLLOW,
        );
        const valid = (stat: FileIdentity) =>
          same(stat, saved!.identity) &&
          stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.uid === uid &&
          (stat.mode & 0o7777) === 0o600 &&
          stat.nlink === 1;
        if (!valid(deps.fs.fstatSync(fileFd))) fail();
        const actual = Buffer.alloc(saved.data.length + 1);
        let offset = 0;
        while (offset < actual.length) {
          const count = deps.fs.readSync(fileFd, actual, offset, actual.length - offset, offset);
          if (!Number.isSafeInteger(count) || count < 0 || count > actual.length - offset) fail();
          if (count === 0) break;
          offset += count;
        }
        if (
          offset !== saved.data.length ||
          !actual.subarray(0, offset).equals(saved.data) ||
          !valid(deps.fs.fstatSync(fileFd)) ||
          !valid(deps.fs.lstatSync(path)) ||
          !same(deps.fs.lstatSync(directory), pinned)
        )
          fail();
      } catch {
        throw new MariaDbRuntimeObservationError();
      } finally {
        let cleanupFailed = false;
        if (fileFd !== undefined) {
          try {
            deps.fs.closeSync(fileFd);
          } catch {
            cleanupFailed = true;
          }
        }
        if (directoryFd !== undefined) {
          try {
            deps.fs.closeSync(directoryFd);
          } catch {
            cleanupFailed = true;
          }
        }
        if (cleanupFailed) throw new MariaDbRuntimeObservationError();
      }
    };
    const sink: MariaDbRuntimeObservationSink = (observation) => {
      try {
        const now = deps.now();
        if (
          !Number.isSafeInteger(now) ||
          now < started ||
          !observation ||
          typeof observation !== "object" ||
          Array.isArray(observation) ||
          Reflect.ownKeys(observation).length !== keys.length ||
          keys.some((key) => !Object.hasOwn(observation, key))
        )
          fail();
        if (
          observation.schemaVersion !== 1 ||
          observation.role !== roles[component] ||
          observation.verifiedTls !== true ||
          !["TLSv1.2", "TLSv1.3"].includes(observation.tlsVersion) ||
          !isSupportedMariaDbServerVersion(observation.serverVersion)
        )
          fail();
        for (const digest of [
          observation.accountIdentitySha256,
          observation.databaseIdentitySha256,
          observation.sessionIdentitySha256,
        ])
          if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) fail();
        const observed = instant(observation.observedAt);
        if (observed < started || observed > now) fail();
        if (captured) return;
        const record = Object.freeze({
          schemaVersion: 1,
          component,
          pid: deps.pid,
          pidScope: "process-local",
          bootId,
          controllerStartedAt: new Date(started).toISOString(),
          observedAt: observation.observedAt,
          challenge,
          observation: Object.freeze({ ...observation }),
          admission: false,
          runtimeImagesVerified: false,
        });
        const data = Buffer.from(JSON.stringify(record) + "\n", "utf8");
        if (data.length > 16384) fail();
        let directoryFd: number | undefined,
          fileFd: number | undefined,
          own: FileIdentity | undefined,
          temporary: string | undefined,
          final: string | undefined;
        const cleanupOwn = (path: string | undefined) => {
          if (!path || !own) return;
          try {
            if (same(deps.fs.lstatSync(path), own)) deps.fs.unlinkSync(path);
          } catch {
            /* Never touch an unknown inode or expose diagnostics. */
          }
        };
        try {
          directoryFd = deps.fs.openSync(
            directory,
            nativeFs.constants.O_RDONLY |
              nativeFs.constants.O_DIRECTORY |
              nativeFs.constants.O_NOFOLLOW,
          );
          const pinned = deps.fs.fstatSync(directoryFd);
          if (
            !directoryValid(pinned) ||
            !same(initial, pinned) ||
            !same(deps.fs.lstatSync(directory), pinned)
          )
            fail();
          const prefix = "/proc/self/fd/" + directoryFd;
          const filename = "runtime-observation-" + component + "-" + bootId + ".json";
          temporary = join(prefix, filename + ".pending");
          final = join(prefix, filename);
          fileFd = deps.fs.openSync(
            temporary,
            nativeFs.constants.O_WRONLY |
              nativeFs.constants.O_CREAT |
              nativeFs.constants.O_EXCL |
              nativeFs.constants.O_NOFOLLOW,
            0o600,
          );
          own = deps.fs.fstatSync(fileFd);
          if (!own.isFile() || own.uid !== uid || (own.mode & 0o7777) !== 0o600 || own.nlink !== 1)
            fail();
          let offset = 0;
          while (offset < data.length) {
            const written = deps.fs.writeSync(fileFd, data, offset, data.length - offset);
            if (!Number.isSafeInteger(written) || written <= 0 || written > data.length - offset)
              fail();
            offset += written;
          }
          deps.fs.fsyncSync(fileFd);
          if (!same(deps.fs.lstatSync(temporary), own)) fail();
          deps.fs.linkSync(temporary, final);
          if (!same(deps.fs.lstatSync(final), own) || !same(deps.fs.lstatSync(directory), pinned))
            fail();
          deps.fs.unlinkSync(temporary);
          temporary = undefined;
          deps.fs.closeSync(fileFd);
          fileFd = undefined;
          deps.fs.closeSync(directoryFd);
          directoryFd = undefined;
          saved = { filename, identity: own, data: Buffer.from(data) };
          captured = true;
        } catch {
          cleanupOwn(final);
          cleanupOwn(temporary);
          fail();
        } finally {
          if (fileFd !== undefined) {
            try {
              deps.fs.closeSync(fileFd);
            } catch {
              /* Generic failure already returned. */
            }
          }
          if (directoryFd !== undefined) {
            try {
              deps.fs.closeSync(directoryFd);
            } catch {
              /* No retained descriptor. */
            }
          }
        }
      } catch {
        throw new MariaDbRuntimeObservationError();
      }
    };
    return Object.freeze({ sink, assertCaptured });
  } catch {
    throw new MariaDbRuntimeObservationError();
  }
}
