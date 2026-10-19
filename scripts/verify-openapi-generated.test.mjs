import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import { generateOpenApiClient } from "./generate-openapi-client.mjs";
import { verifyGeneratedOpenApi } from "./verify-openapi-generated.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureCache = join(repositoryRoot, ".cache");

function documentFixture() {
  return {
    openapi: "3.0.0",
    info: { title: "Synthetic fixture", version: "1" },
    paths: {
      "/api/v1/fixtures": {
        get: {
          operationId: "FixturesController_read",
          responses: {
            200: {
              description: "Fixture response",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { label: { type: "string" } } },
                },
              },
            },
          },
        },
      },
    },
  };
}

function generatorSource(document) {
  return `import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
const { values } = parseArgs({ options: { output: { type: "string" } } });
if (!values.output) throw new Error("An isolated output path is required");
const document = ${JSON.stringify(document)};
await writeFile(values.output, JSON.stringify(document, null, 2) + "\\n", "utf8");
`;
}

async function createFixture(t) {
  await mkdir(fixtureCache, { recursive: true });
  const root = await mkdtemp(join(fixtureCache, "openapi-generated-test-"));
  t.after(async () => {
    const ownedPath = relative(fixtureCache, root);
    assert(ownedPath.startsWith("openapi-generated-test-") && dirname(ownedPath) === ".");
    await rm(root, { recursive: true, force: true });
  });
  const apiRoot = join(root, "apps/api");
  const sourcePath = join(apiRoot, "src/openapi/generate.ts");
  const liveBuildPath = join(apiRoot, "dist/openapi/generate.js");
  const documentPath = join(root, "packages/api-client/openapi/openapi.json");
  const typesPath = join(root, "packages/api-client/src/generated.ts");
  for (const path of [sourcePath, liveBuildPath, documentPath]) {
    await mkdir(dirname(path), { recursive: true });
  }
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(
    join(apiRoot, "tsconfig.build.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        rootDir: "src",
        outDir: "dist",
        types: ["node"],
        strict: true,
        skipLibCheck: true,
        noEmitOnError: true,
      },
      include: ["src/**/*.ts"],
    }),
  );
  const document = documentFixture();
  await writeFile(sourcePath, generatorSource(document));
  await writeFile(liveBuildPath, 'throw new Error("The running API build must not be used");\n');
  await writeFile(documentPath, `${JSON.stringify(document, null, 2)}\n`);
  await generateOpenApiClient(documentPath, typesPath);
  return { root, apiRoot, sourcePath, liveBuildPath, documentPath, typesPath, document };
}

async function verifyWithoutOverwriting(fixture, expectedError) {
  const preservedPaths = [
    fixture.sourcePath,
    fixture.liveBuildPath,
    fixture.documentPath,
    fixture.typesPath,
  ];
  const before = await Promise.all(preservedPaths.map((path) => readFile(path)));
  try {
    if (expectedError) {
      await assert.rejects(verifyGeneratedOpenApi(fixture.root), expectedError);
    } else {
      await verifyGeneratedOpenApi(fixture.root);
    }
  } finally {
    const after = await Promise.all(preservedPaths.map((path) => readFile(path)));
    assert.deepEqual(
      after,
      before,
      "Verification must preserve sources, saved artifacts, and the running build",
    );
    assert.deepEqual(
      await readdir(join(fixture.apiRoot, ".cache")),
      [],
      "Temporary output must be cleaned after success and failure",
    );
  }
}

test("regenerates from current source, ignores old dist, and preserves all inputs", async (t) => {
  await verifyWithoutOverwriting(await createFixture(t));
});

test("fails when source changes but the saved document and client remain mutually consistent", async (t) => {
  const fixture = await createFixture(t);
  fixture.document.paths["/api/v1/fixtures"].get.responses[200].content[
    "application/json"
  ].schema.properties.count = { type: "integer" };
  await writeFile(fixture.sourcePath, generatorSource(fixture.document));
  await verifyWithoutOverwriting(fixture, (error) => {
    assert.match(error.message, /artifacts are stale/u);
    assert.match(error.message, /openapi\/openapi\.json/u);
    assert.match(error.message, /src\/generated\.ts/u);
    assert.match(error.message, /corepack pnpm openapi:generate/u);
    return true;
  });
});

test("rejects a changed saved document even if the client type stays correct", async (t) => {
  const fixture = await createFixture(t);
  fixture.document.info.title = "Outdated saved title";
  await writeFile(fixture.documentPath, JSON.stringify(fixture.document, null, 2) + "\n");
  await verifyWithoutOverwriting(fixture, (error) => {
    assert.match(error.message, /openapi\/openapi\.json/u);
    assert.doesNotMatch(error.message, /src\/generated\.ts/u);
    return true;
  });
});

test("rejects a changed saved client even if the document is correct", async (t) => {
  const fixture = await createFixture(t);
  const types = await readFile(fixture.typesPath, "utf8");
  assert(types.includes("label?: string;"));
  await writeFile(fixture.typesPath, types.replace("label?: string;", "label?: number;"));
  await verifyWithoutOverwriting(fixture, (error) => {
    assert.match(error.message, /src\/generated\.ts/u);
    assert.doesNotMatch(error.message, /openapi\/openapi\.json/u);
    return true;
  });
});

test("accepts CRLF checkouts without rewriting them", async (t) => {
  const fixture = await createFixture(t);
  for (const path of [fixture.documentPath, fixture.typesPath]) {
    await writeFile(path, (await readFile(path, "utf8")).replaceAll("\n", "\r\n"));
  }
  await verifyWithoutOverwriting(fixture);
});

test("fails closed and cleans up when current source does not compile", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(fixture.sourcePath, "const invalid: string = 42;\n");
  await verifyWithoutOverwriting(fixture, /OpenAPI source compilation failed/u);
});

test("fails closed and cleans up when document generation exits unsuccessfully", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(fixture.sourcePath, "process.exit(7);\n");
  await verifyWithoutOverwriting(fixture, /OpenAPI document generation failed/u);
});

test("rejects a successful document process that emits no document", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(fixture.sourcePath, "export {};\n");
  await verifyWithoutOverwriting(fixture, /OpenAPI client generation failed[\s\S]*ENOENT/u);
});

test("fails closed when type generation cannot consume the document", async (t) => {
  const fixture = await createFixture(t);
  fixture.document.openapi = "2.0.0";
  await writeFile(fixture.sourcePath, generatorSource(fixture.document));
  await verifyWithoutOverwriting(fixture, /OpenAPI client generation failed/u);
});

test("the shared local and CI gate runs regeneration checks and their regressions", async () => {
  const { scripts } = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const steps = scripts.check.split(" && ");
  assert.equal(scripts["verify:openapi-generated"], "node scripts/verify-openapi-generated.mjs");
  assert.equal(
    scripts["test:openapi-generated"],
    "node --test scripts/verify-openapi-generated.test.mjs",
  );
  assert(steps.includes("corepack pnpm test:openapi-generated"));
  assert(steps.includes("corepack pnpm verify:openapi-generated"));
  assert(
    steps.indexOf("corepack pnpm build") < steps.indexOf("corepack pnpm verify:openapi-generated"),
  );
  assert(
    steps.indexOf("corepack pnpm verify:openapi-generated") <
      steps.indexOf("corepack pnpm verify:openapi-contract"),
  );
  assert.equal(scripts["ci:local"], "corepack pnpm check");
  const ci = await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /run: pnpm check/u);
});
