import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const REQUIRED = ["docker-compose.yml", "env.example", "docker/db-init.sh"];
const OPTIONAL = [
  "docker-compose.first95-tls.yml",
  "env.first95.example",
  "docker-compose.runtime-observation.yml",
  "env.runtime-observation.example",
];

/** Read reviewed configuration from the selected commit, never the working tree. */
export function readServerReleaseConfiguration({ repositoryRoot, commit }) {
  assert(/^[a-f0-9]{40}$/u.test(commit ?? ""), "Exact configuration source commit required");
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repositoryRoot,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  assert.equal(git("rev-parse", `${commit}^{commit}`).toString().trim(), commit);
  const files = [];
  for (const path of [...REQUIRED, ...OPTIONAL]) {
    const source = `OPERATIONS/server-release/${path}`;
    const entry = git("ls-tree", commit, "--", source).toString().trim();
    if (!entry && OPTIONAL.includes(path)) continue;
    assert(/^100(?:644|755) blob /u.test(entry), "Configuration must be a regular Git blob");
    files.push({ path, bytes: git("show", `${commit}:${source}`) });
  }
  return files;
}
