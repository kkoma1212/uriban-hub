import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

export const OUTPUT_PATHS = Object.freeze({
  inventory: "THIRD_PARTY_NOTICES.json",
  notice: "THIRD_PARTY_NOTICES.md",
  licenseDirectory: "THIRD_PARTY_LICENSES",
});

// This is a technical recognition list, not a legal approval list. A new
// expression deliberately stops generation until its redistribution terms are
// reviewed and the list is updated.
export const RECOGNIZED_LICENSE_EXPRESSIONS = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "MIT-0",
  "OFL-1.1",
  "Python-2.0",
]);

// 여러 라이선스가 함께 적용되는 "미리 빌드된 바이너리 묶음"은 식 전체를 일반 허용 목록에 넣지 않는다.
// 정확한 패키지@버전마다, 재배포 때 함께 줘야 하는 원문·포함 라이브러리 목록·원본 소스 위치를 고정해
// 고지에 반드시 붙인다(없으면 실패). 버전이 바뀌면 다시 검토해야 하므로 닫힌 채로 실패한다.
const LICENSE_TEXT_DIRECTORY = fileURLToPath(new URL("./license-texts/", import.meta.url));
const PINNED_LICENSE_TEXTS = Object.freeze({
  // gnu.org 원문(2026-09-28 받음). 널리 알려진 공식 SHA-256과 같다.
  "GPL-3.0": {
    file: "GPL-3.0.txt",
    sha256: "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986",
  },
  "LGPL-3.0": {
    file: "LGPL-3.0.txt",
    sha256: "e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118",
  },
});
export const BINARY_BUNDLE_LICENSES = new Map([
  [
    // sharp 0.35.4 Windows 완성본: sharp(Apache-2.0) + libvips 8.18.6과 LGPLv3 DLL(glib·pango·librsvg·
    // libheif·libexif·fribidi·proxy-libintl), MPL-2.0(cairo) 등. 서버(API)에서만 쓰며 Web 번들에는 없다.
    "@img/sharp-win32-x64@0.35.4",
    {
      expression: "Apache-2.0 AND LGPL-3.0-or-later",
      licenseTexts: ["LGPL-3.0", "GPL-3.0"],
      packageSections: [{ path: "README.md", heading: "Licensing" }, { path: "versions.json" }],
      correspondingSource:
        "Corresponding source for the bundled LGPL/MPL libraries: sharp-libvips v1.3.3 " +
        "(libvips 8.18.6; exact library versions in versions.json) - " +
        "https://github.com/lovell/sharp-libvips/tree/v1.3.3 . The libraries are separate shared " +
        "libraries (DLLs) and may be replaced by the user. When this binary is conveyed to a third " +
        "party (for example an installer or container image), keep an archived copy of that source " +
        "available as required by LGPL-3.0 section 4 and GPL-3.0 section 6.",
    },
  ],
]);

const legalFilePattern = /^(?:licen[cs]e|copying|notice)(?:$|[._-])/iu;
const unknownLicensePattern = /(?:^|\W)(?:unknown|unlicensed|noassertion)(?:$|\W)/iu;

// Some published npm tarballs omit a top-level legal file even though their
// package metadata declares a recognized license. These version-pinned
// fallbacks make that exception explicit and fail closed on dependency updates.
// They are technical provenance rules, not legal approval decisions.
const LEGAL_FILE_FALLBACKS = new Map([
  [
    "@redis/bloom@6.1.0",
    { sourcePackage: "redis@6.1.0", path: "README.md", markdownLicenseSection: true },
  ],
  [
    "@redis/client@6.1.0",
    { sourcePackage: "redis@6.1.0", path: "README.md", markdownLicenseSection: true },
  ],
  [
    "@redis/json@6.1.0",
    { sourcePackage: "redis@6.1.0", path: "README.md", markdownLicenseSection: true },
  ],
  [
    "@redis/search@6.1.0",
    { sourcePackage: "redis@6.1.0", path: "README.md", markdownLicenseSection: true },
  ],
  [
    "@redis/time-series@6.1.0",
    { sourcePackage: "redis@6.1.0", path: "README.md", markdownLicenseSection: true },
  ],
  ["@tokenizer/token@0.3.0", { path: "README.md", markdownLicenseSection: true }],
  ["abstract-logging@2.0.1", { path: "Readme.md", markdownLicenseSection: true }],
  ["pg-types@2.2.0", { path: "README.md", markdownLicenseSection: true }],
  ["pgpass@1.0.5", { path: "README.md", markdownLicenseSection: true }],
  ["pretendard@1.3.9", { path: "dist/LICENSE.txt", markdownLicenseSection: false }],
  ["redis@6.1.0", { path: "README.md", markdownLicenseSection: true }],
]);

function extractMarkdownLicenseSection(markdown, packageId, sourceName) {
  const lines = normalizeText(markdown).split("\n");
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s+licen[cs]e\s*$/iu.test(line));
  if (headingIndex === -1) {
    throw new Error(`${packageId} fallback has no License heading: ${sourceName}`);
  }
  const headingLevel = lines[headingIndex].match(/^#+/u)[0].length;
  let endIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{1,6})\s+/u);
    if (heading && heading[1].length <= headingLevel) {
      endIndex = index;
      break;
    }
  }
  const section = normalizeText(lines.slice(headingIndex, endIndex).join("\n"));
  if (section.trim() === "")
    throw new Error(`${packageId} fallback license section is empty: ${sourceName}`);
  return section;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeText(value) {
  return value.replace(/\r\n?/gu, "\n").replace(/\n*$/u, "\n");
}

function comparePackages(left, right) {
  return (
    left.name.localeCompare(right.name, "en") || left.version.localeCompare(right.version, "en")
  );
}

function normalizeUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  let normalized = value.trim();
  if (normalized.startsWith("github:")) normalized = `https://github.com/${normalized.slice(7)}`;
  if (normalized.startsWith("git+")) normalized = normalized.slice(4);
  if (normalized.startsWith("git://github.com/")) {
    normalized = `https://github.com/${normalized.slice("git://github.com/".length)}`;
  }
  if (normalized.startsWith("ssh://git@github.com/")) {
    normalized = `https://github.com/${normalized.slice("ssh://git@github.com/".length)}`;
  }
  if (normalized.startsWith("git@github.com:")) {
    normalized = `https://github.com/${normalized.slice("git@github.com:".length)}`;
  }
  normalized = normalized.replace(/\.git(?:#.*)?$/u, "");
  try {
    const url = new URL(normalized);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href.replace(/\/$/u, "")
      : null;
  } catch {
    return null;
  }
}

function repositoryUrl(manifest) {
  const repository = manifest.repository;
  const raw = typeof repository === "string" ? repository : repository?.url;
  const normalized = normalizeUrl(raw);
  if (normalized === null) return null;
  const directory = typeof repository === "object" ? repository.directory : null;
  return typeof directory === "string" && directory.trim() !== ""
    ? `${normalized}/tree/HEAD/${directory.replace(/^\/+|\/+$/gu, "")}`
    : normalized;
}

function registryUrl(name, version) {
  return `https://www.npmjs.com/package/${name}/v/${version}`;
}

function packagePurl(name, version) {
  if (name.startsWith("@")) {
    const [scope, packageName] = name.slice(1).split("/");
    if (!scope || !packageName) throw new Error(`invalid scoped package name: ${name}`);
    return `pkg:npm/%40${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function manifestLicense(manifest) {
  if (typeof manifest.license === "string") return manifest.license.trim();
  if (Array.isArray(manifest.licenses)) {
    const values = manifest.licenses
      .map((item) => (typeof item === "string" ? item : item?.type))
      .filter((item) => typeof item === "string" && item.trim() !== "")
      .map((item) => item.trim());
    return values.length === 1 ? values[0] : null;
  }
  return null;
}

function assertRecognizedLicense(value, packageId) {
  const bundle = BINARY_BUNDLE_LICENSES.get(packageId);
  if (bundle !== undefined && value === bundle.expression) return;
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    unknownLicensePattern.test(value) ||
    value.toUpperCase().startsWith("SEE LICENSE IN ") ||
    !RECOGNIZED_LICENSE_EXPRESSIONS.has(value)
  ) {
    throw new Error(
      `${packageId} has an unrecognized or unapproved-for-inventory license expression: ${String(value)}`,
    );
  }
}

async function readLegalFiles(packageRoot, packageId) {
  const entries = (await readdir(packageRoot, { withFileTypes: true }))
    .filter((entry) => legalFilePattern.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));

  const legalFiles = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      throw new Error(`${packageId} legal artifact is not a regular file: ${entry.name}`);
    }
    const source = normalizeText(await readFile(path.join(packageRoot, entry.name), "utf8"));
    if (source.trim() === "")
      throw new Error(`${packageId} has an empty legal artifact: ${entry.name}`);
    legalFiles.push({ source_name: entry.name, content: source, sha256: sha256(source) });
  }
  return legalFiles;
}

function extractMarkdownSection(markdown, heading, packageId, sourceName) {
  const lines = normalizeText(markdown).split("\n");
  const start = lines.findIndex(
    (line) => /^#{1,6}\s+/u.test(line) && line.replace(/^#{1,6}\s+/u, "").trim() === heading,
  );
  if (start === -1) throw new Error(`${packageId} has no "${heading}" section: ${sourceName}`);
  const level = lines[start].match(/^#+/u)[0].length;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{1,6})\s+/u);
    if (match && match[1].length <= level) {
      end = index;
      break;
    }
  }
  return normalizeText(lines.slice(start, end).join("\n"));
}

async function readBinaryBundleSupplements(packageRoot, packageId) {
  const bundle = BINARY_BUNDLE_LICENSES.get(packageId);
  if (bundle === undefined) return [];
  const files = [];
  const add = (sourceName, content) => {
    if (content.trim() === "") throw new Error(`${packageId} supplement is empty: ${sourceName}`);
    files.push({ source_name: sourceName, content, sha256: sha256(content) });
  };
  for (const name of bundle.licenseTexts) {
    const pinned = PINNED_LICENSE_TEXTS[name];
    const content = normalizeText(
      await readFile(path.join(LICENSE_TEXT_DIRECTORY, pinned.file), "utf8"),
    );
    if (sha256(content) !== pinned.sha256)
      throw new Error(`pinned license text changed: ${pinned.file}`);
    add(`license-texts/${pinned.file}`, content);
  }
  for (const section of bundle.packageSections) {
    const source = await readFile(path.join(packageRoot, section.path), "utf8");
    add(
      section.heading ? `${section.path}#${section.heading.toLowerCase()}` : section.path,
      section.heading
        ? extractMarkdownSection(source, section.heading, packageId, section.path)
        : normalizeText(source),
    );
  }
  add("corresponding-source.txt", normalizeText(bundle.correspondingSource));
  return files;
}

async function readFallbackLegalFiles(packageRoot, packageId, packageRootsById) {
  const fallback = LEGAL_FILE_FALLBACKS.get(packageId);
  if (fallback === undefined) return [];
  const sourcePackage = fallback.sourcePackage ?? packageId;
  const sourceRoot =
    sourcePackage === packageId ? packageRoot : packageRootsById.get(sourcePackage);
  if (sourceRoot === undefined) {
    throw new Error(
      `${packageId} fallback source package is not in the production graph: ${sourcePackage}`,
    );
  }
  const sourcePath = path.join(sourceRoot, fallback.path);
  const source = await readFile(sourcePath, "utf8");
  const content = fallback.markdownLicenseSection
    ? extractMarkdownLicenseSection(source, packageId, fallback.path)
    : normalizeText(source);
  if (content.trim() === "")
    throw new Error(`${packageId} fallback legal artifact is empty: ${fallback.path}`);
  return [
    {
      source_name: fallback.markdownLicenseSection ? `${fallback.path}#license` : fallback.path,
      source_package: sourcePackage,
      content,
      sha256: sha256(content),
    },
  ];
}

function stablePackageMetadata(manifest, licenseExpression) {
  const repository = repositoryUrl(manifest);
  const homepage = normalizeUrl(manifest.homepage);
  const npmRegistry = registryUrl(manifest.name, manifest.version);
  return {
    name: manifest.name,
    version: manifest.version,
    purl: packagePurl(manifest.name, manifest.version),
    license_expression: licenseExpression,
    source_url: repository ?? homepage ?? npmRegistry,
    repository_url: repository,
    homepage_url: homepage,
    registry_url: npmRegistry,
  };
}

export async function buildArtifacts({ licenseReport, lockfile, packageManager }) {
  if (licenseReport === null || typeof licenseReport !== "object" || Array.isArray(licenseReport)) {
    throw new Error("pnpm production license report must be a JSON object");
  }
  if (!/^pnpm@\d+\.\d+\.\d+$/u.test(packageManager)) {
    throw new Error(`packageManager must pin an exact pnpm version: ${packageManager}`);
  }

  const packageRootsById = new Map();
  for (const reportItems of Object.values(licenseReport)) {
    if (!Array.isArray(reportItems)) continue;
    for (const reportItem of reportItems) {
      if (!Array.isArray(reportItem.paths)) continue;
      for (const packageRoot of reportItem.paths) {
        const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
        const packageId = `${String(manifest.name)}@${String(manifest.version)}`;
        const priorRoot = packageRootsById.get(packageId);
        if (priorRoot === undefined || packageRoot.localeCompare(priorRoot, "en") < 0) {
          packageRootsById.set(packageId, packageRoot);
        }
      }
    }
  }

  const packagesById = new Map();
  const bundledTexts = new Map();
  const packagesWithoutLegalFiles = [];
  for (const [reportLicense, reportItems] of Object.entries(licenseReport)) {
    if (!Array.isArray(reportItems))
      throw new Error(`license report group is not an array: ${reportLicense}`);
    // 일반 허용 목록 밖의 식은 그 묶음의 모든 패키지·버전이 같은 식으로 고정돼 있을 때만 받는다.
    const pinnedGroup =
      !RECOGNIZED_LICENSE_EXPRESSIONS.has(reportLicense) &&
      reportItems.length > 0 &&
      reportItems.every(
        (item) =>
          Array.isArray(item.versions) &&
          item.versions.length > 0 &&
          item.versions.every(
            (version) =>
              BINARY_BUNDLE_LICENSES.get(`${String(item.name)}@${version}`)?.expression ===
              reportLicense,
          ),
      );
    if (!pinnedGroup) assertRecognizedLicense(reportLicense, `report group ${reportLicense}`);

    for (const reportItem of reportItems) {
      if (!Array.isArray(reportItem.paths) || reportItem.paths.length === 0) {
        throw new Error(`${String(reportItem.name)} has no installed package path`);
      }
      for (const packageRoot of [...new Set(reportItem.paths)].sort()) {
        const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
        const packageId = `${String(manifest.name)}@${String(manifest.version)}`;
        if (manifest.name !== reportItem.name || !reportItem.versions?.includes(manifest.version)) {
          throw new Error(`${packageId} does not match its pnpm license report entry`);
        }
        const declaredLicense = manifestLicense(manifest);
        assertRecognizedLicense(declaredLicense, packageId);
        if (declaredLicense !== reportLicense || reportItem.license !== reportLicense) {
          throw new Error(`${packageId} license disagrees between package.json and pnpm report`);
        }

        let legalFiles = await readLegalFiles(packageRoot, packageId);
        if (legalFiles.length === 0) {
          legalFiles = await readFallbackLegalFiles(packageRoot, packageId, packageRootsById);
        }
        if (legalFiles.length === 0) {
          packagesWithoutLegalFiles.push(packageId);
          continue;
        }
        legalFiles = [
          ...legalFiles,
          ...(await readBinaryBundleSupplements(packageRoot, packageId)),
        ];
        const packageEntry = {
          ...stablePackageMetadata(manifest, declaredLicense),
          legal_files: legalFiles.map(
            ({ source_name, source_package = packageId, content, sha256: contentHash }) => {
              const bundlePath = `${OUTPUT_PATHS.licenseDirectory}/${contentHash}.txt`;
              const existing = bundledTexts.get(bundlePath);
              if (existing !== undefined && existing !== content) {
                throw new Error(`SHA-256 collision while bundling ${packageId}`);
              }
              bundledTexts.set(bundlePath, content);
              return { source_package, source_name, bundle_path: bundlePath, sha256: contentHash };
            },
          ),
        };

        const prior = packagesById.get(packageId);
        const serialized = JSON.stringify(packageEntry);
        if (prior !== undefined && JSON.stringify(prior) !== serialized) {
          throw new Error(`${packageId} has inconsistent metadata across installed peer variants`);
        }
        packagesById.set(packageId, packageEntry);
      }
    }
  }

  if (packagesWithoutLegalFiles.length > 0) {
    throw new Error(
      `production packages without a published top-level legal file:\n${[
        ...new Set(packagesWithoutLegalFiles),
      ]
        .sort()
        .map((packageId) => `- ${packageId}`)
        .join("\n")}`,
    );
  }

  const packages = [...packagesById.values()].sort(comparePackages);
  if (packages.length === 0) throw new Error("production dependency inventory is empty");
  const inventory = {
    schema_version: 1,
    scope: "pnpm-production-dependencies",
    generated_by: "scripts/third-party-notices.mjs",
    reproducibility: {
      package_manager: packageManager,
      lockfile_path: "pnpm-lock.yaml",
      lockfile_sha256: sha256(lockfile),
    },
    legal_review: {
      status: "required",
      statement:
        "This inventory is a technical redistribution artifact, not legal advice or legal approval. Release approval must be recorded separately by the responsible organization.",
    },
    package_count: packages.length,
    packages,
  };

  const markdownRows = packages.map((item) => {
    const legalLinks = item.legal_files
      .map((file) => `[${file.source_package}:${file.source_name}](${file.bundle_path})`)
      .join(", ");
    return `| \`${item.name}\` | \`${item.version}\` | \`${item.license_expression}\` | [source](${item.source_url}) | ${legalLinks} |`;
  });
  const notice =
    normalizeText(`<!-- Generated by scripts/third-party-notices.mjs. Do not edit manually. -->
# Third-party notices

This document covers the production npm dependency graph pinned by \`pnpm-lock.yaml\`.
It is a technical inventory and redistribution bundle, not legal advice or legal approval.
The responsible organization must complete and record legal review before a commercial release.

- Scope: production dependencies and optional production dependencies
- Package count: ${packages.length}
- Lockfile SHA-256: \`${inventory.reproducibility.lockfile_sha256}\`
- Package manager: \`${packageManager}\`

| Package | Version | SPDX license | Source | Bundled legal text |
| --- | --- | --- | --- | --- |
${markdownRows.join("\n")}
`);

  return {
    inventory: `${JSON.stringify(inventory, null, 2)}\n`,
    notice,
    bundledTexts: new Map(
      [...bundledTexts.entries()].sort(([left], [right]) => left.localeCompare(right, "en")),
    ),
  };
}

async function assertFileEquals(filePath, expected) {
  let actual;
  try {
    actual = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `required generated artifact is missing: ${path.relative(repositoryRoot, filePath)}`,
      { cause: error },
    );
  }
  if (actual !== expected)
    throw new Error(`generated artifact is stale: ${path.relative(repositoryRoot, filePath)}`);
}

export async function writeArtifacts(root, artifacts) {
  const licenseDirectory = path.join(root, OUTPUT_PATHS.licenseDirectory);
  await rm(licenseDirectory, { recursive: true, force: true });
  await mkdir(licenseDirectory, { recursive: true });
  await writeFile(path.join(root, OUTPUT_PATHS.inventory), artifacts.inventory, "utf8");
  await writeFile(path.join(root, OUTPUT_PATHS.notice), artifacts.notice, "utf8");
  for (const [relativePath, content] of artifacts.bundledTexts) {
    await writeFile(path.join(root, relativePath), content, "utf8");
  }
}

export async function verifyArtifacts(root, artifacts) {
  await assertFileEquals(path.join(root, OUTPUT_PATHS.inventory), artifacts.inventory);
  await assertFileEquals(path.join(root, OUTPUT_PATHS.notice), artifacts.notice);
  const expectedNames = [...artifacts.bundledTexts.keys()]
    .map((filePath) => path.basename(filePath))
    .sort();
  let actualNames;
  try {
    actualNames = (await readdir(path.join(root, OUTPUT_PATHS.licenseDirectory))).sort();
  } catch (error) {
    throw new Error(
      `required generated artifact directory is missing: ${OUTPUT_PATHS.licenseDirectory}`,
      { cause: error },
    );
  }
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`${OUTPUT_PATHS.licenseDirectory} contains missing or unexpected files`);
  }
  for (const [relativePath, content] of artifacts.bundledTexts) {
    await assertFileEquals(path.join(root, relativePath), content);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "generate" && mode !== "verify") {
    throw new Error("usage: third-party-notices.mjs <generate|verify>");
  }
  const rootManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const lockfile = await readFile(path.join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
  const reportText = await readStdin();
  const licenseReport = JSON.parse(reportText);
  const artifacts = await buildArtifacts({
    licenseReport,
    lockfile,
    packageManager: rootManifest.packageManager,
  });
  if (mode === "generate") {
    await writeArtifacts(repositoryRoot, artifacts);
    process.stdout.write(
      `generated third-party notices for ${JSON.parse(artifacts.inventory).package_count} production packages\n`,
    );
  } else {
    await verifyArtifacts(repositoryRoot, artifacts);
    process.stdout.write(
      `verified third-party notices for ${JSON.parse(artifacts.inventory).package_count} production packages\n`,
    );
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
