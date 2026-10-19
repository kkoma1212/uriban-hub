const TLS_MATERIAL_QUERY_KEYS = new Set(["sslcert", "sslkey", "sslrootcert"]);
const BENIGN_QUERY_KEYS = new Set(["application_name"]);

export interface ProductionDatabaseUrlOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  expectedUsername: string;
  variableName: string;
}

function decodeNonblankUrlComponent(value: string): string | undefined {
  try {
    const decodedValue = decodeURIComponent(value);
    return decodedValue.trim().length > 0 ? decodedValue : undefined;
  } catch {
    return undefined;
  }
}

function normalizeLegacyIpv4Hostname(hostname: string): string | undefined {
  const ipv4Number = "(?:0[xX][0-9a-fA-F]+|[0-9]+)";
  if (!new RegExp(`^${ipv4Number}(?:\\.${ipv4Number}){0,3}$`, "u").test(hostname)) {
    return undefined;
  }

  try {
    const normalizedHostname = new URL(`http://${hostname}/`).hostname;
    return /^\d+\.\d+\.\d+\.\d+$/u.test(normalizedHostname) ? normalizedHostname : undefined;
  } catch {
    return undefined;
  }
}

function hasCanonicalRawQueryKeys(databaseUrl: URL): boolean {
  const rawQuery = databaseUrl.search.slice(1);
  if (rawQuery.length === 0) return false;

  return rawQuery.split("&").every((parameter) => {
    const separatorIndex = parameter.indexOf("=");
    const rawKey = separatorIndex === -1 ? parameter : parameter.slice(0, separatorIndex);
    if (!/^[a-z_]+$/u.test(rawKey)) return false;
    if (rawKey === "sslmode" && parameter !== "sslmode=verify-full") return false;

    return true;
  });
}

function isExplicitRemoteHostname(hostname: string): boolean {
  const decodedHostname = decodeNonblankUrlComponent(hostname);
  if (decodedHostname === undefined || /[/\\]/u.test(decodedHostname)) return false;

  const normalizedHostname = decodedHostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");

  const effectiveHostname = normalizeLegacyIpv4Hostname(normalizedHostname) ?? normalizedHostname;
  return !(
    effectiveHostname === "localhost" ||
    effectiveHostname.endsWith(".localhost") ||
    effectiveHostname === "0.0.0.0" ||
    effectiveHostname.startsWith("127.") ||
    effectiveHostname === "::" ||
    effectiveHostname === "::1" ||
    effectiveHostname.startsWith("::ffff:127.") ||
    effectiveHostname.startsWith("::ffff:7f")
  );
}

function hasExplicitConnectionAuthority(databaseUrl: URL): boolean {
  return (
    isExplicitRemoteHostname(databaseUrl.hostname) &&
    decodeNonblankUrlComponent(databaseUrl.password) !== undefined &&
    decodeNonblankUrlComponent(databaseUrl.pathname.slice(1)) !== undefined
  );
}

function hasSafeTlsQuery(databaseUrl: URL): boolean {
  if (!hasCanonicalRawQueryKeys(databaseUrl)) return false;

  let sslModeCount = 0;
  const seenQueryKeys = new Set<string>();

  for (const [rawKey, value] of databaseUrl.searchParams) {
    if (rawKey !== rawKey.toLowerCase() || seenQueryKeys.has(rawKey)) return false;
    seenQueryKeys.add(rawKey);

    if (rawKey === "sslmode") {
      sslModeCount += 1;
      if (value !== "verify-full") return false;
      continue;
    }

    if (TLS_MATERIAL_QUERY_KEYS.has(rawKey)) {
      if (value.trim().length === 0) return false;
      continue;
    }

    if (BENIGN_QUERY_KEYS.has(rawKey)) {
      if (value.trim().length === 0) return false;
      continue;
    }

    return false;
  }

  return sslModeCount === 1;
}

function assertNoTlsEnvironmentOverrides(
  environment: Readonly<Record<string, string | undefined>>,
  variableName: string,
): void {
  for (const [rawName, rawValue] of Object.entries(environment)) {
    if (rawValue === undefined || rawValue.trim().length === 0) continue;

    const name = rawName.toUpperCase();
    if (name === "NODE_TLS_REJECT_UNAUTHORIZED" && rawValue.trim() === "0") {
      throw new Error(
        `${variableName} cannot be used when NODE_TLS_REJECT_UNAUTHORIZED disables certificate verification.`,
      );
    }
    if (name.startsWith("PGSSL")) {
      throw new Error(`${variableName} cannot be combined with PGSSL* environment variables.`);
    }
  }
}

export function assertProductionDatabaseUrl(
  connectionString: string,
  options: ProductionDatabaseUrlOptions,
): void {
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(connectionString);
  } catch {
    throw new Error(`${options.variableName} must be a valid PostgreSQL URL.`);
  }

  if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
    throw new Error(`${options.variableName} must be a PostgreSQL URL.`);
  }
  if (databaseUrl.username !== options.expectedUsername) {
    throw new Error(
      `${options.variableName} must use the ${options.expectedUsername} database role.`,
    );
  }
  if (!hasExplicitConnectionAuthority(databaseUrl)) {
    throw new Error(
      `${options.variableName} must include an explicit remote hostname, nonblank password, and database name.`,
    );
  }
  if (!hasSafeTlsQuery(databaseUrl)) {
    throw new Error(
      `${options.variableName} must use one canonical sslmode=verify-full and only approved connection query options.`,
    );
  }

  assertNoTlsEnvironmentOverrides(options.environment ?? process.env, options.variableName);
}
