import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildArtifacts,
  OUTPUT_PATHS,
  verifyArtifacts,
  writeArtifacts,
} from "./third-party-notices.mjs";

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "classhub-licenses-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function createPackage(
  root,
  { name, version, license = "MIT", legalName = "LICENSE", legalText = "Permission granted.\n" },
) {
  const directory = path.join(root, name.replaceAll("/", "__"), version);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify({
      name,
      version,
      license,
      repository: { type: "git", url: `git+https://example.test/${name}.git` },
    })}\n`,
  );
  if (legalName !== null) {
    const legalPath = path.join(directory, legalName);
    await mkdir(path.dirname(legalPath), { recursive: true });
    await writeFile(legalPath, legalText);
  }
  return directory;
}

function licenseReport(packages) {
  const report = {};
  for (const item of packages) {
    report[item.license] ??= [];
    report[item.license].push({
      name: item.name,
      versions: [item.version],
      paths: [item.path],
      license: item.license,
    });
  }
  return report;
}

test("builds a deterministic, sorted production inventory with bundled legal text", async (t) => {
  const root = await temporaryDirectory(t);
  const zetaPath = await createPackage(root, {
    name: "zeta",
    version: "2.0.0",
    license: "MIT",
    legalText: "Zeta terms.\r\n",
  });
  const alphaPath = await createPackage(root, {
    name: "@scope/alpha",
    version: "1.0.0",
    license: "Apache-2.0",
    legalText: "Alpha terms.\n",
  });
  const input = {
    licenseReport: licenseReport([
      { name: "zeta", version: "2.0.0", license: "MIT", path: zetaPath },
      {
        name: "@scope/alpha",
        version: "1.0.0",
        license: "Apache-2.0",
        path: alphaPath,
      },
    ]),
    lockfile: "lockfileVersion: '9.0'\n",
    packageManager: "pnpm@11.11.0",
  };

  const first = await buildArtifacts(input);
  const second = await buildArtifacts(input);
  assert.deepEqual(first, second);
  const inventory = JSON.parse(first.inventory);
  assert.equal(inventory.package_count, 2);
  assert.deepEqual(
    inventory.packages.map((item) => item.name),
    ["@scope/alpha", "zeta"],
  );
  assert.equal(inventory.packages[0].purl, "pkg:npm/%40scope/alpha@1.0.0");
  assert.match(inventory.packages[0].source_url, /^https:\/\/example\.test\//u);
  assert.equal(first.bundledTexts.size, 2);
});

test("fails closed for unknown licenses and missing legal artifacts", async (t) => {
  const root = await temporaryDirectory(t);
  const unknownPath = await createPackage(root, {
    name: "unknown-license",
    version: "1.0.0",
    license: "UNLICENSED",
  });
  await assert.rejects(
    buildArtifacts({
      licenseReport: licenseReport([
        {
          name: "unknown-license",
          version: "1.0.0",
          license: "UNLICENSED",
          path: unknownPath,
        },
      ]),
      lockfile: "lock\n",
      packageManager: "pnpm@11.11.0",
    }),
    /unrecognized or unapproved-for-inventory license expression/u,
  );

  const missingPath = await createPackage(root, {
    name: "missing-legal-file",
    version: "1.0.0",
    legalName: null,
  });
  await assert.rejects(
    buildArtifacts({
      licenseReport: licenseReport([
        {
          name: "missing-legal-file",
          version: "1.0.0",
          license: "MIT",
          path: missingPath,
        },
      ]),
      lockfile: "lock\n",
      packageManager: "pnpm@11.11.0",
    }),
    /production packages without a published top-level legal file/u,
  );
});

test("uses only explicit version-pinned README fallbacks", async (t) => {
  const root = await temporaryDirectory(t);
  const redisPath = await createPackage(root, {
    name: "redis",
    version: "6.1.0",
    legalName: "README.md",
    legalText: "# Redis\n\n## License\n\nMIT terms from upstream.\n\n## End\n",
  });
  const bloomPath = await createPackage(root, {
    name: "@redis/bloom",
    version: "6.1.0",
    legalName: null,
  });
  const artifacts = await buildArtifacts({
    licenseReport: licenseReport([
      { name: "redis", version: "6.1.0", license: "MIT", path: redisPath },
      { name: "@redis/bloom", version: "6.1.0", license: "MIT", path: bloomPath },
    ]),
    lockfile: "lock\n",
    packageManager: "pnpm@11.11.0",
  });
  const inventory = JSON.parse(artifacts.inventory);
  const bloom = inventory.packages.find((item) => item.name === "@redis/bloom");
  assert.equal(bloom.legal_files[0].source_package, "redis@6.1.0");
  assert.equal(bloom.legal_files[0].source_name, "README.md#license");
  assert.equal(
    artifacts.bundledTexts.get(bloom.legal_files[0].bundle_path),
    "## License\n\nMIT terms from upstream.\n",
  );
});

test("verifier rejects stale or unexpected generated files", async (t) => {
  const root = await temporaryDirectory(t);
  const packagePath = await createPackage(root, { name: "example", version: "1.0.0" });
  const artifacts = await buildArtifacts({
    licenseReport: licenseReport([
      { name: "example", version: "1.0.0", license: "MIT", path: packagePath },
    ]),
    lockfile: "lock\n",
    packageManager: "pnpm@11.11.0",
  });

  await writeArtifacts(root, artifacts);
  await verifyArtifacts(root, artifacts);
  await writeFile(path.join(root, OUTPUT_PATHS.licenseDirectory, "unexpected.txt"), "unexpected\n");
  await assert.rejects(verifyArtifacts(root, artifacts), /contains missing or unexpected files/u);
});

test("accepts a copyleft binary bundle only at its pinned version and attaches its obligations", async (t) => {
  const root = await temporaryDirectory(t);
  const expression = "Apache-2.0 AND LGPL-3.0-or-later";
  const bundle = async (name, version) => {
    const directory = await createPackage(root, {
      name,
      version,
      license: expression,
      legalText: "Apache License\nVersion 2.0\n",
    });
    await writeFile(
      path.join(directory, "README.md"),
      "# pkg\n\n## Licensing\n\n| libvips | LGPLv3 |\n\n## Other\n\nignored\n",
    );
    await writeFile(path.join(directory, "versions.json"), '{"vips":"8.18.6"}\n');
    return directory;
  };
  const build = (name, version, directory) =>
    buildArtifacts({
      licenseReport: licenseReport([{ name, version, license: expression, path: directory }]),
      lockfile: "lock\n",
      packageManager: "pnpm@11.11.0",
    });

  const pinned = await bundle("@img/sharp-win32-x64", "0.35.4");
  const inventory = JSON.parse((await build("@img/sharp-win32-x64", "0.35.4", pinned)).inventory);
  assert.deepEqual(
    inventory.packages[0].legal_files.map((file) => file.source_name),
    [
      "LICENSE",
      "license-texts/LGPL-3.0.txt",
      "license-texts/GPL-3.0.txt",
      "README.md#licensing",
      "versions.json",
      "corresponding-source.txt",
    ],
  );

  // 다른 버전이나 다른 패키지는 같은 식이어도 다시 검토 전까지 막는다.
  const nextVersion = await bundle("@img/sharp-win32-x64", "0.35.5");
  await assert.rejects(
    build("@img/sharp-win32-x64", "0.35.5", nextVersion),
    /unrecognized or unapproved-for-inventory license expression/u,
  );
  const otherPackage = await bundle("some-other-binary", "0.35.4");
  await assert.rejects(
    build("some-other-binary", "0.35.4", otherPackage),
    /unrecognized or unapproved-for-inventory license expression/u,
  );

  // 포함 라이브러리 목록(README Licensing 절)이 없으면 고지를 만들지 않는다.
  const missingSection = await bundle("@img/sharp-win32-x64", "0.35.4-missing");
  await writeFile(path.join(missingSection, "README.md"), "# pkg\n");
  await writeFile(
    path.join(missingSection, "package.json"),
    `${JSON.stringify({ name: "@img/sharp-win32-x64", version: "0.35.4", license: expression })}\n`,
  );
  await assert.rejects(
    build("@img/sharp-win32-x64", "0.35.4", missingSection),
    /has no "Licensing" section/u,
  );
});
