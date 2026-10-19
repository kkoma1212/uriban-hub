import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fileConstants, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { arch, homedir, platform, release, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_OUTPUT = join(REPOSITORY_ROOT, "QUALITY", "frozen-offline-install-evidence.json");
const TEMP_PREFIX = "classhub-w2-01-";
const CHILD_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_TAIL_BYTES = 64 * 1024;
const ESCAPE_CHARACTER = String.fromCharCode(27);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function portablePath(value) {
  return value.split(sep).join("/");
}

function pathInside(parent, child) {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  const pathFromParent = relative(parentPath, childPath);
  return (
    pathFromParent.length > 0 &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

function parseArguments(argv) {
  let output = DEFAULT_OUTPUT;
  let keepTemp = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--keep-temp") {
      keepTemp = true;
    } else if (argument === "--output") {
      const next = argv[index + 1];
      if (!next) throw new Error("--output requires a path");
      output = resolve(REPOSITORY_ROOT, next);
      index += 1;
    } else if (argument === "--help") {
      process.stdout.write(
        "Usage: node scripts/frozen-offline-install-evidence.mjs " +
          "[--output <workspace-path>] [--keep-temp]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!pathInside(REPOSITORY_ROOT, output)) {
    throw new Error("Evidence output must stay inside the repository");
  }

  return { keepTemp, output };
}

async function manifestPaths() {
  const paths = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
  if (existsSync(join(REPOSITORY_ROOT, ".npmrc"))) paths.push(".npmrc");

  for (const workspaceRoot of ["apps", "packages"]) {
    const directory = join(REPOSITORY_ROOT, workspaceRoot);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifest = join(workspaceRoot, entry.name, "package.json");
      if (existsSync(join(REPOSITORY_ROOT, manifest))) paths.push(manifest);
    }
  }

  return paths.toSorted((left, right) => left.localeCompare(right, "en"));
}

async function fingerprintInputs(paths) {
  const aggregate = createHash("sha256");
  const files = [];

  for (const path of paths) {
    const content = await readFile(join(REPOSITORY_ROOT, path));
    const digest = sha256(content);
    const normalizedPath = portablePath(path);
    aggregate.update(normalizedPath).update("\0").update(digest).update("\0");
    files.push({ bytes: content.byteLength, path: normalizedPath, sha256: digest });
  }

  return { files, sha256: aggregate.digest("hex") };
}

async function copyInputs(paths, destination) {
  for (const path of paths) {
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(REPOSITORY_ROOT, path), target);
  }
}

async function copyStoreArtifacts(source, destination) {
  const startedAt = performance.now();
  const pending = [{ destination, relative: "", source }];
  let copiedFileCount = 0;
  await mkdir(destination, { recursive: true });

  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current.source, { withFileTypes: true });
    for (const entry of entries) {
      if (current.relative.length === 0 && entry.name === "projects") continue;
      const sourcePath = join(current.source, entry.name);
      const destinationPath = join(current.destination, entry.name);
      const relativePath = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await mkdir(destinationPath, { recursive: true });
        pending.push({
          destination: destinationPath,
          relative: relativePath,
          source: sourcePath,
        });
      } else if (entry.isFile()) {
        await copyFile(sourcePath, destinationPath, fileConstants.COPYFILE_FICLONE);
        copiedFileCount += 1;
      }
    }
  }

  return {
    copiedFileCount,
    durationMs: Math.round(performance.now() - startedAt),
    excludedTopLevelNames: ["projects"],
  };
}

function sanitizedEnvironment() {
  const environment = { ...process.env };
  const strippedNames = [];
  for (const name of Object.keys(environment)) {
    if (/(?:TOKEN|AUTH|PASSWORD|PASSWD|SECRET|PRIVATE_KEY)/iu.test(name)) {
      delete environment[name];
      strippedNames.push(name);
    }
  }

  Object.assign(environment, {
    CI: "1",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENABLE_NETWORK: "0",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    npm_config_fetch_retries: "0",
    npm_config_fetch_retry_maxtimeout: "0",
    npm_config_fetch_retry_mintimeout: "0",
    npm_config_fetch_timeout: "5000",
  });

  return { environment, strippedNames: strippedNames.toSorted() };
}

function appendTail(current, chunk) {
  const combined = Buffer.concat([current, chunk]);
  return combined.byteLength <= MAX_OUTPUT_TAIL_BYTES
    ? combined
    : combined.subarray(combined.byteLength - MAX_OUTPUT_TAIL_BYTES);
}

async function runProcess(command, args, options) {
  const startedAt = performance.now();
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTail = Buffer.alloc(0);
  let stderrTail = Buffer.alloc(0);
  let spawnError;
  let timedOut = false;

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.byteLength;
    stdoutHash.update(chunk);
    stdoutTail = appendTail(stdoutTail, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.byteLength;
    stderrHash.update(chunk);
    stderrTail = appendTail(stderrTail, chunk);
  });
  child.on("error", (error) => {
    spawnError = error;
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, options.timeoutMs ?? CHILD_TIMEOUT_MS);
  const forcedTermination = setTimeout(
    () => {
      if (timedOut) child.kill("SIGKILL");
    },
    (options.timeoutMs ?? CHILD_TIMEOUT_MS) + 5_000,
  );

  const completion = await new Promise((resolveCompletion) => {
    child.on("close", (exitCode, signal) => resolveCompletion({ exitCode, signal }));
  });
  clearTimeout(timeout);
  clearTimeout(forcedTermination);

  return {
    durationMs: Math.round(performance.now() - startedAt),
    exitCode: completion.exitCode,
    signal: completion.signal,
    spawnError: spawnError?.code ?? null,
    stderrBytes,
    stderrSha256: stderrHash.digest("hex"),
    stderrTail: stderrTail.toString("utf8"),
    stdoutBytes,
    stdoutSha256: stdoutHash.digest("hex"),
    stdoutTail: stdoutTail.toString("utf8"),
    timedOut,
  };
}

function sanitizeOutput(value, replacements) {
  let output = value.split(ESCAPE_CHARACTER).join("");
  for (const [needle, replacement] of replacements) {
    if (!needle) continue;
    output = output.split(needle).join(replacement);
    output = output.split(needle.replaceAll("\\", "/")).join(replacement);
  }
  return output
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1<redacted>@")
    .replace(/([?&](?:token|auth|password|secret)=)[^&\s]+/giu, "$1<redacted>");
}

function outputSummary(processResult, replacements) {
  const combined = sanitizeOutput(
    `${processResult.stdoutTail}\n${processResult.stderrTail}`,
    replacements,
  );
  const errorCode = combined.match(/ERR_PNPM_[A-Z0-9_]+/u)?.[0] ?? null;
  const lines = combined
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        /ERR_PNPM_|Done in|Lockfile is up to date|Packages:|Progress: resolved|404|offline/iu.test(
          line,
        ),
    )
    .slice(-12)
    .map((line) => line.slice(0, 300));
  return { errorCode, lines };
}

async function commandText(command, args, options) {
  const result = await runProcess(command, args, options);
  if (result.exitCode !== 0 || result.timedOut || result.spawnError) {
    throw new Error(
      `Command failed (${args.join(" ")}): exit=${String(result.exitCode)} ` +
        `timeout=${String(result.timedOut)} spawn=${String(result.spawnError)}`,
    );
  }
  return result.stdoutTail.trimEnd();
}

async function pathInventory(root, excludedTopLevelNames = new Set()) {
  if (!existsSync(root)) return { entryCount: 0, sha256: sha256("") };
  const pending = [{ absolute: root, relative: "" }];
  const paths = [];

  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current.absolute, { withFileTypes: true });
    for (const entry of entries) {
      if (current.relative.length === 0 && excludedTopLevelNames.has(entry.name)) {
        continue;
      }
      const relativePath = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        pending.push({
          absolute: join(current.absolute, entry.name),
          relative: relativePath,
        });
      } else {
        paths.push(relativePath);
      }
    }
  }

  paths.sort((left, right) => left.localeCompare(right, "en"));
  const hash = createHash("sha256");
  for (const path of paths) hash.update(path).update("\0");
  return { entryCount: paths.length, sha256: hash.digest("hex") };
}

async function virtualStoreInventory(workspace) {
  const directory = join(workspace, "node_modules", ".pnpm");
  if (!existsSync(directory)) return { entryCount: 0, sha256: sha256("") };
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right, "en"));
  return { entryCount: names.length, sha256: sha256(names.join("\0")) };
}

async function startRegistrySentinel() {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    request.resume();
    response.writeHead(404, {
      connection: "close",
      "content-type": "application/json",
    });
    response.end('{"error":"classhub local registry sentinel"}');
  });
  await new Promise((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    server.listen(0, "127.0.0.1", resolveListening);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Registry sentinel did not bind to an IP socket");
  }
  return {
    close: () => {
      server.closeAllConnections();
      return new Promise((resolveClose) => server.close(resolveClose));
    },
    requestCount: () => requestCount,
    url: `http://127.0.0.1:${address.port}/`,
  };
}

async function gitText(args, environment) {
  return commandText("git", args, {
    cwd: REPOSITORY_ROOT,
    env: environment,
    timeoutMs: 30_000,
  });
}

function publicCommand(caseDefinition) {
  const argumentsList = [
    "corepack",
    "pnpm",
    "install",
    "--frozen-lockfile",
    ...(caseDefinition.offline ? ["--offline"] : []),
    ...(caseDefinition.lockfileOnly ? ["--lockfile-only", "--ignore-scripts"] : []),
    "--store-dir",
    caseDefinition.storeKind === "isolated-warm-clone"
      ? "<ISOLATED_WARM_STORE_CLONE>"
      : "<EMPTY_ISOLATED_STORE>",
    "--registry",
    "<LOCAL_REGISTRY_SENTINEL>",
    "--reporter",
    "append-only",
  ];
  if (!caseDefinition.offline) argumentsList.push("--network-concurrency", "1");
  return argumentsList.join(" ");
}

async function runCase({
  caseDefinition,
  corepackScript,
  environment,
  inputPaths,
  registry,
  replacements,
  tempRoot,
  warmStore,
}) {
  const caseRoot = join(tempRoot, caseDefinition.id);
  const workspace = join(caseRoot, "workspace");
  const store =
    caseDefinition.storeKind === "isolated-warm-clone" ? warmStore : join(caseRoot, "empty-store");
  await mkdir(workspace, { recursive: true });
  await mkdir(store, { recursive: true });
  await copyInputs(inputPaths, workspace);

  const storeBefore =
    caseDefinition.storeKind === "isolated-empty" ? await pathInventory(store) : null;
  const registryRequestsBefore = registry.requestCount();
  const args = [
    corepackScript,
    "pnpm",
    "install",
    "--frozen-lockfile",
    ...(caseDefinition.offline ? ["--offline"] : []),
    ...(caseDefinition.lockfileOnly ? ["--lockfile-only", "--ignore-scripts"] : []),
    "--store-dir",
    store,
    "--registry",
    registry.url,
    "--reporter",
    "append-only",
  ];
  if (!caseDefinition.offline) args.push("--network-concurrency", "1");

  const result = await runProcess(process.execPath, args, {
    cwd: workspace,
    env: environment,
  });
  const summary = outputSummary(result, replacements);
  const lockfileAfterSha256 = sha256(await readFile(join(workspace, "pnpm-lock.yaml")));
  const storeAfter =
    caseDefinition.storeKind === "isolated-empty" ? await pathInventory(store) : null;
  const registryRequestCount = registry.requestCount() - registryRequestsBefore;

  return {
    cache: {
      after: storeAfter,
      before: storeBefore,
      mode: caseDefinition.storeKind,
    },
    command: publicCommand(caseDefinition),
    duration_ms: result.durationMs,
    expected: caseDefinition.expected,
    exit_code: result.exitCode,
    id: caseDefinition.id,
    lifecycle_scripts: caseDefinition.lockfileOnly ? "disabled" : "workspace-policy",
    lockfile_after_sha256: lockfileAfterSha256,
    lockfile_unchanged: lockfileAfterSha256 === caseDefinition.lockfileSha256,
    network: {
      pnpm_offline_flag: caseDefinition.offline,
      registry_mode: "loopback-404-sentinel",
      registry_request_count: registryRequestCount,
    },
    output: {
      error_code: summary.errorCode,
      stderr_bytes: result.stderrBytes,
      stderr_sha256: result.stderrSha256,
      stdout_bytes: result.stdoutBytes,
      stdout_sha256: result.stdoutSha256,
      summary_lines: summary.lines,
    },
    signal: result.signal,
    spawn_error: result.spawnError,
    timed_out: result.timedOut,
    virtual_store: await virtualStoreInventory(workspace),
  };
}

function outcomeMatches(caseResult) {
  if (caseResult.expected === "success") return caseResult.exit_code === 0;
  if (caseResult.expected === "offline-cache-miss") {
    return (
      caseResult.exit_code !== 0 &&
      caseResult.output.error_code === "ERR_PNPM_NO_OFFLINE_TARBALL" &&
      caseResult.network.registry_request_count === 0
    );
  }
  if (caseResult.expected === "registry-request-blocked") {
    return caseResult.exit_code !== 0 && caseResult.network.registry_request_count > 0;
  }
  return false;
}

function safeEnvironmentPresence() {
  const names = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "NPM_CONFIG_REGISTRY",
    "PNPM_HOME",
    "COREPACK_HOME",
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
  ];
  return Object.fromEntries(names.map((name) => [name, Boolean(process.env[name])]));
}

async function cleanupTemporaryRoot(systemTemp, temporaryRoot) {
  const pathFromSystemTemp = relative(systemTemp, temporaryRoot);
  if (!pathInside(systemTemp, temporaryRoot) || !pathFromSystemTemp.startsWith(TEMP_PREFIX)) {
    throw new Error("Refusing to clean an unexpected temporary path");
  }
  await rm(temporaryRoot, { force: true, maxRetries: 3, recursive: true });
}

async function main() {
  const { keepTemp, output } = parseArguments(process.argv.slice(2));
  const tempRoot = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  const resolvedTempRoot = resolve(tempRoot);
  const resolvedSystemTemp = resolve(tmpdir());
  if (
    !pathInside(resolvedSystemTemp, resolvedTempRoot) ||
    !relative(resolvedSystemTemp, resolvedTempRoot).startsWith(TEMP_PREFIX)
  ) {
    throw new Error("Refusing to use an unexpected temporary path");
  }

  const corepackScript = join(
    dirname(process.execPath),
    "node_modules",
    "corepack",
    "dist",
    "corepack.js",
  );
  if (!existsSync(corepackScript)) throw new Error("Corepack script was not found");

  const { environment, strippedNames } = sanitizedEnvironment();
  const inputPaths = await manifestPaths();
  const inputs = await fingerprintInputs(inputPaths);
  const lockfileSha256 = inputs.files.find((file) => file.path === "pnpm-lock.yaml")?.sha256;
  if (!lockfileSha256) throw new Error("pnpm-lock.yaml fingerprint is missing");

  let registry;
  try {
    const nodeVersion = process.version;
    const corepackVersion = await commandText(process.execPath, [corepackScript, "--version"], {
      cwd: REPOSITORY_ROOT,
      env: environment,
      timeoutMs: 30_000,
    });
    const pnpmVersion = await commandText(process.execPath, [corepackScript, "pnpm", "--version"], {
      cwd: REPOSITORY_ROOT,
      env: environment,
      timeoutMs: 30_000,
    });
    const defaultStore = resolve(
      await commandText(process.execPath, [corepackScript, "pnpm", "store", "path"], {
        cwd: REPOSITORY_ROOT,
        env: environment,
        timeoutMs: 30_000,
      }),
    );
    if (!existsSync(defaultStore)) throw new Error("Default pnpm store was not found");

    const head = await gitText(["rev-parse", "HEAD"], environment);
    const status = await gitText(["status", "--porcelain=v1"], environment);
    const statusLines = status.length === 0 ? [] : status.split(/\r?\n/u);
    const inputStatus = await gitText(
      ["status", "--porcelain=v1", "--", ...inputPaths],
      environment,
    );
    const excludedStorePaths = new Set(["projects"]);
    const hostStoreBefore = await pathInventory(defaultStore, excludedStorePaths);
    const warmStore = join(resolvedTempRoot, "warm-store-clone", "v11");
    const warmStoreClone = await copyStoreArtifacts(defaultStore, warmStore);
    const warmStoreBefore = await pathInventory(warmStore, excludedStorePaths);
    registry = await startRegistrySentinel();

    const replacements = [
      [warmStore, "<ISOLATED_WARM_STORE_CLONE>"],
      [REPOSITORY_ROOT, "<REPOSITORY>"],
      [resolvedTempRoot, "<TEMP_ROOT>"],
      [defaultStore, "<HOST_PREPOPULATED_STORE>"],
      [homedir(), "<HOME>"],
      [registry.url, "<LOCAL_REGISTRY_SENTINEL>"],
    ];
    const definitions = [
      {
        expected: "success",
        id: "warm_offline_repeat_a",
        lockfileOnly: false,
        offline: true,
        storeKind: "isolated-warm-clone",
      },
      {
        expected: "success",
        id: "warm_offline_repeat_b",
        lockfileOnly: false,
        offline: true,
        storeKind: "isolated-warm-clone",
      },
      {
        expected: "offline-cache-miss",
        id: "empty_offline_full",
        lockfileOnly: false,
        offline: true,
        storeKind: "isolated-empty",
      },
      {
        expected: "success",
        id: "empty_offline_lockfile_only",
        lockfileOnly: true,
        offline: true,
        storeKind: "isolated-empty",
      },
      {
        expected: "registry-request-blocked",
        id: "empty_registry_probe",
        lockfileOnly: false,
        offline: false,
        storeKind: "isolated-empty",
      },
    ].map((definition) => ({ ...definition, lockfileSha256 }));

    const cases = [];
    for (const caseDefinition of definitions) {
      const result = await runCase({
        caseDefinition,
        corepackScript,
        environment,
        inputPaths,
        registry,
        replacements,
        tempRoot: resolvedTempRoot,
        warmStore,
      });
      cases.push({ ...result, outcome_matches_expectation: outcomeMatches(result) });
    }

    await registry.close();
    registry = undefined;
    const hostStoreAfter = await pathInventory(defaultStore, excludedStorePaths);
    const warmStoreAfter = await pathInventory(warmStore, excludedStorePaths);
    const warmCases = cases.filter((result) => result.id.startsWith("warm_offline_repeat_"));
    const emptyOffline = cases.find((result) => result.id === "empty_offline_full");
    const lockfileOnly = cases.find((result) => result.id === "empty_offline_lockfile_only");
    const registryProbe = cases.find((result) => result.id === "empty_registry_probe");
    const warmRepeatMatched =
      warmCases.length === 2 &&
      warmCases.every((result) => result.exit_code === 0) &&
      warmCases[0].virtual_store.sha256 === warmCases[1].virtual_store.sha256 &&
      warmCases[0].virtual_store.entryCount === warmCases[1].virtual_store.entryCount;
    const matrixMatchesExpectation = cases.every((result) => result.outcome_matches_expectation);

    const evidence = {
      schema_version: 1,
      requirement_id: "DEV-W2-01",
      generated_at: new Date().toISOString(),
      scope: {
        install_workspace: "manifest-only clean temporary workspace",
        product_code_changed_by_harness: false,
        database_accessed: false,
        external_registry_configured: false,
        host_pnpm_store_used_as_read_only_clone_source: true,
        service_processes_managed: false,
      },
      environment: {
        architecture: arch(),
        corepack: corepackVersion,
        filesystem_boundary: "OS temp and host pnpm store on the same Windows volume",
        inherited_environment_presence: safeEnvironmentPresence(),
        node: nodeVersion,
        operating_system: `${platform()} ${release()}`,
        pnpm: pnpmVersion,
        sensitive_environment_variable_count_stripped_from_children: strippedNames.length,
      },
      source: {
        git_head: head,
        install_input_status_sha256: sha256(inputStatus),
        repository_dirty_entry_count: statusLines.length,
        repository_staged_entry_count: statusLines.filter(
          (line) => line[0] !== " " && line[0] !== "?",
        ).length,
      },
      inputs,
      cache: {
        host_store_location: "<LOCALAPPDATA>/pnpm/store/v11",
        host_store_before: hostStoreBefore,
        host_store_after: hostStoreAfter,
        host_store_inventory_unchanged:
          hostStoreBefore.entryCount === hostStoreAfter.entryCount &&
          hostStoreBefore.sha256 === hostStoreAfter.sha256,
        warm_store_clone: warmStoreClone,
        warm_store_clone_before: warmStoreBefore,
        warm_store_clone_after: warmStoreAfter,
        warm_store_clone_matches_host_input:
          warmStoreBefore.entryCount === hostStoreBefore.entryCount &&
          warmStoreBefore.sha256 === hostStoreBefore.sha256,
        warm_store_clone_inventory_unchanged:
          warmStoreBefore.entryCount === warmStoreAfter.entryCount &&
          warmStoreBefore.sha256 === warmStoreAfter.sha256,
        inventory_fingerprint_semantics:
          "SHA-256 of sorted relative non-directory paths excluding pnpm project junctions; " +
          "file contents are not re-read",
      },
      cases,
      verdict: {
        cache_independent_offline_install:
          emptyOffline?.exit_code === 0 && emptyOffline.network.registry_request_count === 0,
        cache_artifact_inputs_stable:
          hostStoreBefore.entryCount === hostStoreAfter.entryCount &&
          hostStoreBefore.sha256 === hostStoreAfter.sha256 &&
          warmStoreBefore.entryCount === warmStoreAfter.entryCount &&
          warmStoreBefore.sha256 === warmStoreAfter.sha256,
        empty_cache_registry_dependency_observed:
          registryProbe?.exit_code !== 0 && registryProbe?.network.registry_request_count > 0,
        full_warm_offline_repeat_matched: warmRepeatMatched,
        hermetic_build_proven: false,
        lockfile_only_can_mask_missing_artifacts:
          lockfileOnly?.exit_code === 0 && emptyOffline?.exit_code !== 0,
        matrix_matches_expectation: matrixMatchesExpectation,
        reproduction_complete: cases.length === definitions.length,
        limitation:
          "Warm-store success proves cache-backed offline installation only. " +
          "The manifest snapshot excludes source compilation, and the empty-store control " +
          "determines whether dependency artifacts are independently available.",
      },
    };

    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

    for (const result of cases) {
      process.stdout.write(
        `${result.id}: exit=${String(result.exit_code)} ` +
          `registry_requests=${String(result.network.registry_request_count)} ` +
          `match=${String(result.outcome_matches_expectation)}\n`,
      );
    }
    process.stdout.write(
      `matrix_matches_expectation=${String(matrixMatchesExpectation)}\n` +
        `evidence=${portablePath(relative(REPOSITORY_ROOT, output))}\n`,
    );
    if (!matrixMatchesExpectation) process.exitCode = 2;
  } finally {
    if (registry) await registry.close();
    if (!keepTemp) {
      await cleanupTemporaryRoot(resolvedSystemTemp, resolvedTempRoot);
    } else {
      process.stdout.write(`temporary_workspace_retained=${resolvedTempRoot}\n`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`DEV-W2-01 harness failed: ${error.message}\n`);
  process.exitCode = 1;
});
