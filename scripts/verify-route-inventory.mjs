/*
 * 새 엔드포인트가 역할 경계 검토 없이 조용히 들어오는 것을 막는 덫이다.
 *
 * 왜 분류가 아니라 덫인가: 컨트롤러에는 역할 표시가 없고(가드는 로그인·CSRF만),
 * 역할은 서비스 계층에서 막는다. 그래서 "이 라우트가 교사 전용인가"를 코드에서
 * 기계적으로 읽어낼 수 없다. 자동 판정을 흉내내면 한 건만 틀려도 "지켜지고 있다"고
 * 적힌 거짓 안전망이 된다 — 그래서 판정하지 않고, 목록이 바뀌면 멈춘다.
 *
 * 실패하면 사람이 할 일: 새 엔드포인트가 교사 전용인지 판단하고, 전용이면
 * 거부 테스트를 붙인 뒤(verify-role-denial-test-coverage.mjs 참조) `--update`로
 * 목록을 갱신한다.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = join(repositoryRoot, "packages/api-client/openapi/openapi.json");
const inventoryPath = join(repositoryRoot, "apps/api/test/role-boundary-route-inventory.json");
const METHODS = new Set(["delete", "get", "patch", "post", "put"]);

function contractRoutes(contract) {
  const routes = [];
  for (const [path, item] of Object.entries(contract.paths ?? {})) {
    for (const method of Object.keys(item)) {
      if (METHODS.has(method)) routes.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return routes.sort();
}

const contract = JSON.parse(await readFile(contractPath, "utf8"));
const routes = contractRoutes(contract);

if (process.argv.includes("--update")) {
  const inventory = {
    $comment:
      "역할 경계 검토를 거친 엔드포인트 목록. 이 파일은 어느 라우트가 교사 전용인지 주장하지 않는다 — 목록에 없는 라우트가 나타나면 CI를 멈추는 덫일 뿐이다. 갱신: pnpm verify:route-inventory --update",
    generated_from: "packages/api-client/openapi/openapi.json",
    route_count: routes.length,
    routes,
  };
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  process.stdout.write(`Route inventory updated: ${String(routes.length)} routes.\n`);
  process.exit(0);
}

const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
const known = new Set(inventory.routes);
const current = new Set(routes);
const added = routes.filter((route) => !known.has(route));
const removed = [...known].filter((route) => !current.has(route)).sort();

if (added.length > 0 || removed.length > 0) {
  if (added.length > 0) {
    process.stderr.write(
      `역할 경계를 검토하지 않은 새 엔드포인트 ${String(added.length)}건:\n${added
        .map((route) => `  + ${route}`)
        .join("\n")}\n`,
    );
  }
  if (removed.length > 0) {
    process.stderr.write(
      `사라진 엔드포인트 ${String(removed.length)}건:\n${removed
        .map((route) => `  - ${route}`)
        .join("\n")}\n`,
    );
  }
  process.stderr.write(
    "\n각 엔드포인트가 교사 전용인지 판단하고, 전용이면 거부 테스트를 붙인 뒤\n" +
      "`corepack pnpm verify:route-inventory --update`로 목록을 갱신하세요.\n",
  );
  process.exit(1);
}

process.stdout.write(
  `Route inventory verified: ${String(routes.length)} endpoints, no unreviewed additions. PASS\n`,
);
