import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";

import { format } from "prettier";

import prettierConfig from "../prettier.config.mjs";

const clientRoot = fileURLToPath(new URL("../packages/api-client/", import.meta.url));
const require = createRequire(new URL("../packages/api-client/package.json", import.meta.url));
const { default: openapiTS, astToString, COMMENT_HEADER } = require("openapi-typescript");

export async function generateOpenApiClient(inputFile, outputFile) {
  // Passing parsed JSON avoids the dependency's file-URL decoding failure on Korean Windows paths.
  const document = JSON.parse(await readFile(inputFile, "utf8"));
  const source = `${COMMENT_HEADER}${astToString(await openapiTS(document))}`;
  const formatted = await format(source, { ...prettierConfig, parser: "typescript" });
  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, formatted, "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { input: { type: "string" }, output: { type: "string" } },
    });
    await generateOpenApiClient(
      resolve(values.input ?? resolve(clientRoot, "openapi/openapi.json")),
      resolve(values.output ?? resolve(clientRoot, "src/generated.ts")),
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
