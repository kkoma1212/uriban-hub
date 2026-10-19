import { describe, expect, it, vi } from "vitest";
import {
  createConfiguredRuntimeObservation,
  type RuntimeObservationFileSystem,
  type RuntimeObservationDependencies,
} from "./configured-runtime-observation.js";
import type { MariaDbRuntimeObservation } from "./runtime-observation.js";
const directory = "/private/proofs",
  challenge = "a".repeat(64),
  time = Date.parse("2026-10-10T12:00:00.000Z");
const env = {
  CLASSHUB_RUNTIME_OBSERVATION_DIRECTORY: directory,
  CLASSHUB_RUNTIME_OBSERVATION_CHALLENGE: challenge,
};
const payload: MariaDbRuntimeObservation = {
  schemaVersion: 1,
  role: "worker",
  serverVersion: "11.4.13-MariaDB",
  tlsVersion: "TLSv1.3",
  verifiedTls: true,
  accountIdentitySha256: "b".repeat(64),
  databaseIdentitySha256: "c".repeat(64),
  sessionIdentitySha256: "d".repeat(64),
  observedAt: new Date(time).toISOString(),
};
function fixture() {
  type Stat = ReturnType<RuntimeObservationFileSystem["lstatSync"]>;
  const stat = (ino: number, kind = "directory", mode = 0o700, uid = 1000): Stat => ({
    ino,
    dev: 1,
    mode,
    uid,
    nlink: 1,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symlink",
  });
  const dirs = new Map([
      ["/", stat(1)],
      ["/private", stat(2)],
      [directory, stat(3)],
    ]),
    files = new Map<string, { stat: Stat; data: Buffer }>(),
    fds = new Map<number, { path: string; stat: Stat }>();
  let nextFd = 10,
    nextInode = 10;
  const canonical = (path: string) => path.replace(/^\/proc\/self\/fd\/\d+/, directory);
  const fs: RuntimeObservationFileSystem = {
    lstatSync: vi.fn((path) => {
      path = canonical(path);
      const result = dirs.get(path) ?? files.get(path)?.stat;
      if (!result) throw new Error("private-native-missing");
      return result;
    }),
    fstatSync: vi.fn((fd) => {
      const item = fds.get(fd);
      if (!item) throw new Error("private-fd");
      return item.stat;
    }),
    openSync: vi.fn((path, flags, mode) => {
      path = canonical(path);
      const fd = nextFd++;
      if (path === directory) {
        fds.set(fd, { path, stat: dirs.get(directory)! });
        return fd;
      }
      if (files.has(path) && mode === undefined) {
        fds.set(fd, { path, stat: files.get(path)!.stat });
        return fd;
      }
      if (files.has(path)) throw new Error("private-existing");
      const item = { stat: stat(nextInode++, "file", mode), data: Buffer.alloc(0) };
      files.set(path, item);
      fds.set(fd, { path, stat: item.stat });
      return fd;
    }),
    writeSync: vi.fn((fd, data, offset, length) => {
      const entry = fds.get(fd)!,
        file = files.get(entry.path)!;
      file.data = Buffer.concat([file.data, data.subarray(offset, offset + length)]);
      return length;
    }),
    readSync: vi.fn((fd, data, offset, length, position) => {
      const file = files.get(fds.get(fd)!.path)!;
      const bytes = file.data.subarray(position, position + length);
      bytes.copy(data, offset);
      return bytes.length;
    }),
    fsyncSync: vi.fn(() => undefined),
    closeSync: vi.fn((fd) => {
      fds.delete(fd);
    }),
    linkSync: vi.fn((source, target) => {
      source = canonical(source);
      target = canonical(target);
      if (files.has(target)) throw new Error("private-existing-target");
      files.set(target, files.get(source)!);
    }),
    unlinkSync: vi.fn((path) => {
      path = canonical(path);
      files.delete(path);
    }),
  };
  const deps: RuntimeObservationDependencies = {
    fs,
    platform: "linux",
    getuid: () => 1000,
    pid: 123,
    now: () => time,
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
  };
  return { fs, deps, dirs, files, fds, stat };
}
const reject = (run: () => unknown) => expect(run).toThrow("MariaDB runtime observation failed.");
describe("configured private runtime observation sink", () => {
  it("default optout performs no filesystem access, including on Windows", () => {
    const h = fixture();
    expect(
      createConfiguredRuntimeObservation("worker", {}, { ...h.deps, platform: "win32" }),
    ).toBeUndefined();
    expect(h.fs.lstatSync).not.toHaveBeenCalled();
  });
  it.each([
    { CLASSHUB_RUNTIME_OBSERVATION_DIRECTORY: directory },
    { CLASSHUB_RUNTIME_OBSERVATION_CHALLENGE: challenge },
    { ...env, CLASSHUB_RUNTIME_OBSERVATION_DIRECTORY: "relative" },
    { ...env, CLASSHUB_RUNTIME_OBSERVATION_CHALLENGE: "0" },
    { ...env, CLASSHUB_RUNTIME_OBSERVATION_CHALLENGE: "A".repeat(64) },
  ])("rejects incomplete or malformed configuration %o", (input) => {
    const h = fixture();
    reject(() => createConfiguredRuntimeObservation("worker", input, h.deps));
    expect(h.fds.size).toBe(0);
  });
  it.each(["win32", "darwin"])(
    "fails closed on unsupported %s without filesystem access",
    (platform) => {
      const h = fixture();
      reject(() => createConfiguredRuntimeObservation("worker", env, { ...h.deps, platform }));
      expect(h.fs.lstatSync).not.toHaveBeenCalled();
    },
  );
  it.each(["wrong-owner", "public-mode", "leaf-link", "ancestor-link"])(
    "rejects private-directory boundary %s",
    (attack) => {
      const h = fixture();
      if (attack === "wrong-owner") h.dirs.set(directory, h.stat(3, "directory", 0o700, 1001));
      if (attack === "public-mode") h.dirs.set(directory, h.stat(3, "directory", 0o750));
      if (attack === "leaf-link") h.dirs.set(directory, h.stat(3, "symlink"));
      if (attack === "ancestor-link") h.dirs.set("/private", h.stat(2, "symlink"));
      reject(() => createConfiguredRuntimeObservation("worker", env, h.deps));
      expect(h.fds.size).toBe(0);
    },
  );
  it("records frozen exact process-local evidence once, independent of source/image environment claims", () => {
    const h = fixture(),
      controller = createConfiguredRuntimeObservation(
        "worker",
        { ...env, IMAGE_DIGEST: "private-image", SOURCE_REVISION: "private-source" },
        h.deps,
      )!;
    reject(controller.assertCaptured);
    expect(h.fds.size).toBe(0);
    controller.sink(payload);
    controller.assertCaptured();
    const [name, file] = [...h.files][0]!;
    expect(name).not.toContain("pending");
    expect(file.stat.mode).toBe(0o600);
    expect(file.data.length).toBeLessThanOrEqual(16384);
    const record = JSON.parse(file.data.toString());
    expect(record.pid).toBe(123);
    expect(record.pidScope).toBe("process-local");
    expect(record.challenge).toBe(challenge);
    expect(record.admission).toBe(false);
    expect(record.runtimeImagesVerified).toBe(false);
    expect(JSON.stringify(record)).not.toMatch(
      /private-image|private-source|password|hostname|CA|account@/,
    );
    expect(h.fds.size).toBe(0);
    controller.sink({ ...payload, sessionIdentitySha256: "e".repeat(64) });
    expect(h.files.size).toBe(1);
    expect(h.fs.openSync).toHaveBeenCalledTimes(4);
    reject(() =>
      controller.sink({ ...payload, secret: "private" } as unknown as MariaDbRuntimeObservation),
    );
  });
  it.each([
    { role: "app" },
    { verifiedTls: false },
    { observedAt: "1970-01-01T00:00:00.000Z" },
    { observedAt: new Date(time + 1).toISOString() },
    { databaseIdentitySha256: "bad" },
    { serverVersion: "11.8.1-MariaDB" },
  ])("rejects malformed record values without writing %o", (override) => {
    const h = fixture(),
      controller = createConfiguredRuntimeObservation("worker", env, h.deps)!;
    reject(() => controller.sink({ ...payload, ...override } as MariaDbRuntimeObservation));
    expect(h.fs.openSync).not.toHaveBeenCalled();
  });
  it("rejects directory replacement at capture and leaks no descriptors", () => {
    const h = fixture(),
      controller = createConfiguredRuntimeObservation("worker", env, h.deps)!;
    h.dirs.set(directory, h.stat(99));
    reject(() => controller.sink(payload));
    expect(h.files.size).toBe(0);
    expect(h.fds.size).toBe(0);
  });
  it.each(["partial-write", "zero-write", "fsync", "link-collision"])(
    "cleans only its own incomplete record after %s",
    (attack) => {
      const h = fixture(),
        controller = createConfiguredRuntimeObservation("worker", env, h.deps)!;
      if (attack === "partial-write")
        vi.mocked(h.fs.writeSync)
          .mockImplementationOnce(() => 1)
          .mockImplementationOnce(() => {
            throw new Error("private-password");
          });
      if (attack === "zero-write") vi.mocked(h.fs.writeSync).mockReturnValue(0);
      if (attack === "fsync")
        vi.mocked(h.fs.fsyncSync).mockImplementation(() => {
          throw new Error("private-password");
        });
      if (attack === "link-collision")
        vi.mocked(h.fs.linkSync).mockImplementation((_source, target) => {
          h.files.set(target.replace(/^\/proc\/self\/fd\/\d+/, directory), {
            stat: h.stat(999, "file", 0o600),
            data: Buffer.from("keep"),
          });
          throw new Error("private-password");
        });
      reject(() => controller.sink(payload));
      expect(h.fds.size).toBe(0);
      expect([...h.files.keys()].every((path) => !path.endsWith("pending"))).toBe(true);
      if (attack === "link-collision")
        expect([...h.files.values()][0]!.data.toString()).toBe("keep");
      else expect(h.files.size).toBe(0);
      reject(controller.assertCaptured);
    },
  );
  it("handles valid short writes completely before exclusive publication", () => {
    const h = fixture();
    const full = vi.mocked(h.fs.writeSync).getMockImplementation()!;
    vi.mocked(h.fs.writeSync).mockImplementation((fd, data, offset, length) =>
      full(fd, data, offset, Math.min(length, 7)),
    );
    const controller = createConfiguredRuntimeObservation("worker", env, h.deps)!;
    controller.sink(payload);
    controller.assertCaptured();
    expect(() => JSON.parse([...h.files.values()][0]!.data.toString())).not.toThrow();
    expect(h.fds.size).toBe(0);
  });
  it("rejects zero process time before any capture", () => {
    const h = fixture();
    reject(() => createConfiguredRuntimeObservation("worker", env, { ...h.deps, now: () => 0 }));
    expect(h.fs.openSync).not.toHaveBeenCalled();
  });
});

it.each(["removed", "replaced", "content", "mode", "hardlink", "directory"])(
  "assertCaptured rejects changed private evidence: %s",
  (attack) => {
    const h = fixture(),
      controller = createConfiguredRuntimeObservation("worker", env, h.deps)!;
    controller.sink(payload);
    const [name, file] = [...h.files][0]!;
    if (attack === "removed") h.files.delete(name);
    if (attack === "replaced") file.stat = h.stat(99, "file", 0o600);
    if (attack === "content") file.data = Buffer.from("changed");
    if (attack === "mode") file.stat.mode = 0o640;
    if (attack === "hardlink") file.stat.nlink = 2;
    if (attack === "directory") h.dirs.set(directory, h.stat(99));
    reject(controller.assertCaptured);
    expect(h.fds.size).toBe(0);
  },
);
it.each([
  "/private/link/../proofs",
  "/private//proofs",
  "/private/proofs/",
  "/private/proofs/../proofs",
])("rejects noncanonical Linux paths before filesystem access: %s", (path) => {
  const h = fixture();
  reject(() =>
    createConfiguredRuntimeObservation(
      "worker",
      { ...env, CLASSHUB_RUNTIME_OBSERVATION_DIRECTORY: path },
      h.deps,
    ),
  );
  expect(h.fs.lstatSync).not.toHaveBeenCalled();
});

it.each([
  "/",
  "/private/./proofs",
  "/private/proofs\\bad",
  "/private/proofs\u0000bad",
  "/private/proofs\nbad",
])("rejects forbidden Linux path representation before access: %s", (path) => {
  const h = fixture();
  reject(() =>
    createConfiguredRuntimeObservation(
      "worker",
      { ...env, CLASSHUB_RUNTIME_OBSERVATION_DIRECTORY: path },
      h.deps,
    ),
  );
  expect(h.fs.lstatSync).not.toHaveBeenCalled();
});
it("closes both descriptors and removes its record when a close operation fails", () => {
  const h = fixture(),
    controller = createConfiguredRuntimeObservation("worker", env, h.deps)!;
  const close = vi.mocked(h.fs.closeSync).getMockImplementation()!;
  vi.mocked(h.fs.closeSync)
    .mockImplementationOnce(() => {
      throw new Error("private-close-error");
    })
    .mockImplementation(close);
  reject(() => controller.sink(payload));
  expect(h.fds.size).toBe(0);
  expect(h.files.size).toBe(0);
  reject(controller.assertCaptured);
});
it("assertCaptured read failure closes both descriptors without deleting complete evidence", () => {
  const h = fixture(),
    controller = createConfiguredRuntimeObservation("worker", env, h.deps)!;
  controller.sink(payload);
  vi.mocked(h.fs.readSync).mockImplementation(() => {
    throw new Error("private-read-error");
  });
  reject(controller.assertCaptured);
  expect(h.fds.size).toBe(0);
  expect(h.files.size).toBe(1);
});
it("partial-failure cleanup leaves a replacement inode untouched", () => {
  const h = fixture(),
    controller = createConfiguredRuntimeObservation("worker", env, h.deps)!;
  vi.mocked(h.fs.fsyncSync).mockImplementation(() => {
    const [name] = [...h.files][0]!;
    h.files.set(name, { stat: h.stat(999, "file", 0o600), data: Buffer.from("unknown-file") });
    throw new Error("private-fsync-error");
  });
  reject(() => controller.sink(payload));
  expect(h.fds.size).toBe(0);
  expect([...h.files.values()][0]!.data.toString()).toBe("unknown-file");
});
