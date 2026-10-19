import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { readServerReleaseConfiguration } from "./server-release-config.mjs";

test("selected commit preserves legacy configuration and includes only committed first95 candidates", () => {
  const fixture = mkdtempSync(resolve(tmpdir(), "classhub-release-config-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: fixture,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
  const write = (name, text) => {
    const target = resolve(fixture, "OPERATIONS/server-release", name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  const commit = () => {
    git("add", "OPERATIONS/server-release");
    git(
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    return git("rev-parse", "HEAD");
  };
  try {
    git("init");
    for (const name of ["docker-compose.yml", "env.example", "docker/db-init.sh"])
      write(name, "legacy:" + name);
    const legacy = commit();
    write("docker-compose.first95-tls.yml", "reviewed first95 configuration");
    write("env.first95.example", "FIRST95_APP_DATABASE_URL=\n");
    write("docker-compose.runtime-observation.yml", "reviewed diagnostic overlay");
    write("env.runtime-observation.example", "RUNTIME_OBSERVATION_CHALLENGE=\n");
    const current = commit();
    write("docker-compose.first95-tls.yml", "dirty must never copy");
    write(".env", "private must never copy");
    const old = readServerReleaseConfiguration({ repositoryRoot: fixture, commit: legacy });
    assert.equal(old.length, 3);
    const files = readServerReleaseConfiguration({ repositoryRoot: fixture, commit: current });
    assert.equal(files.length, 7);
    assert.equal(
      files.find((item) => item.path === "docker-compose.runtime-observation.yml").bytes.toString(),
      "reviewed diagnostic overlay",
    );
    assert.equal(
      files.find((item) => item.path === "docker-compose.first95-tls.yml").bytes.toString(),
      "reviewed first95 configuration",
    );
    assert(
      files.every((item) => item.path !== ".env" && !item.bytes.toString().includes("private")),
    );
    assert.throws(() =>
      readServerReleaseConfiguration({ repositoryRoot: fixture, commit: "HEAD" }),
    );
  } finally {
    assert(fixture.startsWith(resolve(tmpdir(), "classhub-release-config-")));
    rmSync(fixture, { recursive: true, force: true });
  }
});
