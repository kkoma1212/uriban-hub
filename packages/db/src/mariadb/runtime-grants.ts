const rejectionMessage = "MariaDB runtime grants rejected";

function reject(): never {
  throw new Error(rejectionMessage);
}

function quoted(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

// The reviewed schema uses these identifier names. Reject additional quoting or
// punctuation forms rather than introducing ambiguous canonical-key delimiters.
function objectName(scope: string, database: string): string {
  const prefix = `${quoted(database)}.`;
  if (!scope.startsWith(prefix)) reject();
  const match = /^`([A-Za-z_][A-Za-z0-9_]*)`$/u.exec(scope.slice(prefix.length));
  return match?.[1] ?? reject();
}

function grantText(row: unknown): string {
  if (typeof row !== "object" || row === null || Array.isArray(row)) reject();
  const keys = Reflect.ownKeys(row);
  if (keys.length !== 1 || typeof keys[0] !== "string") reject();
  const value: unknown = Object.getOwnPropertyDescriptor(row, keys[0])?.value;
  if (typeof value !== "string") reject();
  return value;
}

/**
 * Parses the reviewed MariaDB 11.4 SHOW GRANTS representation, not arbitrary SQL.
 * Authentication metadata is validated but never returned. This does not replace
 * comparison with the expected catalog or CURRENT_USER/current-role attestation.
 */
export function parseMariaDbRuntimeGrants(
  rows: unknown,
  identity: {
    database: string;
    user: string;
    accountHost: string;
    tls?: "required" | "disabled" | undefined;
  },
): string[] {
  try {
    if (!Array.isArray(rows)) reject();
    for (const value of [identity.database, identity.user, identity.accountHost])
      if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value)) reject();
    const account = `${quoted(identity.user)}@${quoted(identity.accountHost)}`;
    const suffix = ` TO ${account}`;
    const usagePrefix = `GRANT USAGE ON *.* TO ${account} IDENTIFIED BY PASSWORD '`;
    const keys = new Set<string>();
    const scopes = new Map<string, Set<string>>();
    let usageCount = 0;

    const add = (kind: "table" | "procedure", name: string, privilege: string, column: string) => {
      const scope = `${kind}|${name}|${privilege}`;
      const existing = scopes.get(scope) ?? new Set<string>();
      // A table-wide grant also duplicates any narrower grant of that privilege.
      if (existing.has(column) || existing.has("*") || (column === "*" && existing.size > 0))
        reject();
      existing.add(column);
      scopes.set(scope, existing);
      keys.add(kind === "table" ? `${scope}|${column}` : scope);
    };

    for (const row of rows) {
      const grant = grantText(row);
      if (/[\r\n]/u.test(grant)) reject();
      if (grant.startsWith("GRANT USAGE ")) {
        if (!grant.startsWith(usagePrefix) || usageCount !== 0) reject();
        // TLS를 명시적으로 끈 설치는 계정에 REQUIRE SSL이 없을 수 있다. 그 밖의 형식은 그대로 고정한다.
        const usageTail =
          identity.tls === "disabled"
            ? /^\*[0-9A-Fa-f]{40}'(?: REQUIRE SSL)?$/u
            : /^\*[0-9A-Fa-f]{40}' REQUIRE SSL$/u;
        if (!usageTail.test(grant.slice(usagePrefix.length))) reject();
        usageCount++;
        continue;
      }
      if (!grant.startsWith("GRANT ") || !grant.endsWith(suffix)) reject();
      const body = grant.slice("GRANT ".length, -suffix.length);
      const routinePrefix = "EXECUTE ON PROCEDURE ";
      if (body.startsWith(routinePrefix)) {
        add(
          "procedure",
          objectName(body.slice(routinePrefix.length), identity.database),
          "EXECUTE",
          "*",
        );
        continue;
      }

      const parts = body.split(" ON ");
      if (parts.length !== 2 || !parts[0] || !parts[1]) reject();
      const table = objectName(parts[1], identity.database);
      let remaining = parts[0];
      while (remaining.length > 0) {
        const clause =
          /^(SELECT|INSERT|UPDATE|DELETE)(?: \((`[A-Za-z_][A-Za-z0-9_]*`(?:, `[A-Za-z_][A-Za-z0-9_]*`)*)\))?(?:, |$)/u.exec(
            remaining,
          );
        if (!clause?.[1]) reject();
        const privilege = clause[1];
        if (clause[2]) {
          if (privilege === "DELETE") reject();
          for (const column of clause[2].split(", "))
            add("table", table, privilege, column.slice(1, -1));
        } else add("table", table, privilege, "*");
        remaining = remaining.slice(clause[0].length);
        if (remaining === "" && clause[0].endsWith(", ")) reject();
      }
    }
    if (usageCount !== 1) reject();
    return [...keys].sort();
  } catch {
    // Malformed objects/getters/proxies must not expose a GRANT line or password hash either.
    throw new Error(rejectionMessage);
  }
}
