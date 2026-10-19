import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const typescriptCli = require.resolve("typescript/bin/tsc");
const clientGenerator = fileURLToPath(new URL("./generate-openapi-client.mjs", import.meta.url));
const executeFile = promisify(execFile);

async function runNode(label, args, cwd) {
  try {
    await executeFile(process.execPath, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`${label} failed:\n${error.stdout ?? ""}${error.stderr || error.message}`, {
      cause: error,
    });
  }
}

export async function verifyGeneratedOpenApi(root = repositoryRoot) {
  const apiRoot = resolve(root, "apps/api");
  const cacheDirectory = join(apiRoot, ".cache");
  await mkdir(cacheDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(cacheDirectory, "openapi-verify-"));

  try {
    const buildDirectory = join(temporaryDirectory, "dist");
    const documentPath = join(temporaryDirectory, "openapi.json");
    const typesPath = join(temporaryDirectory, "generated.ts");

    // Compile current sources separately so a running API keeps its own build output.
    await runNode(
      "OpenAPI source compilation",
      [typescriptCli, "-p", "tsconfig.build.json", "--outDir", buildDirectory],
      apiRoot,
    );
    await runNode(
      "OpenAPI document generation",
      [join(buildDirectory, "openapi/generate.js"), "--output", documentPath],
      apiRoot,
    );
    await runNode(
      "OpenAPI client generation",
      [clientGenerator, "--input", documentPath, "--output", typesPath],
      resolve(root, "packages/api-client"),
    );

    const artifacts = [
      ["packages/api-client/openapi/openapi.json", documentPath],
      ["packages/api-client/src/generated.ts", typesPath],
    ];
    const drifted = [];
    for (const [checkedInPath, generatedPath] of artifacts) {
      const [checkedIn, generated] = await Promise.all([
        readFile(resolve(root, checkedInPath), "utf8"),
        readFile(generatedPath, "utf8"),
      ]);
      if (checkedIn.replaceAll("\r\n", "\n") !== generated.replaceAll("\r\n", "\n")) {
        drifted.push(checkedInPath);
      }
    }
    if (drifted.length > 0) {
      throw new Error(
        `OpenAPI generated artifacts are stale:\n${drifted.map((path) => `  ${path}`).join("\n")}\n` +
          "Run corepack pnpm openapi:generate, review the changes, and commit both generated artifacts.",
      );
    }
  } finally {
    const ownedPath = relative(cacheDirectory, temporaryDirectory);
    if (ownedPath.startsWith("openapi-verify-") && dirname(ownedPath) === ".") {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const started = performance.now();
  try {
    await verifyGeneratedOpenApi();
    process.stdout.write(
      `OpenAPI generated artifacts verified against current sources in ${((performance.now() - started) / 1000).toFixed(1)}s. PASS\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
