import { sql } from "kysely";
import { requiredMariaDbRuntimeGrants, type MariaDbPoolFactory } from "@classhub/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertApiMariaDbDatabaseRole,
  openApiMariaDbDatabase,
  probeApiMariaDbReadiness,
  type ApiMariaDbDatabase,
} from "./mariadb-database.js";

type Pool = ReturnType<MariaDbPoolFactory>;
type Raw = Parameters<Parameters<Pool["getConnection"]>[0]>[1];
const options = {
  host: "qa.invalid",
  database: "qa",
  user: "qa_api",
  accountHost: "%",
  password: "private-password",
  sslCa: "-----BEGIN CERTIFICATE-----\nprivate-ca\n-----END CERTIFICATE-----",
};
const header = { affectedRows: 0, insertId: 0 };
function appGrantRows(profile = "app_help_chat_v1") {
  return requiredMariaDbRuntimeGrants("app", profile)!.map((entry) => {
    const [kind, table, privilege, column] = entry.split("|");
    const permission =
      kind === "procedure"
        ? "EXECUTE ON PROCEDURE"
        : column === "*"
          ? `${privilege} ON`
          : `${privilege} (\`${column}\`) ON`;
    return { grant: `GRANT ${permission} \`qa\`.\`${table}\` TO \`qa_api\`@\`%\`` };
  });
}
function fixture() {
  const statements: string[] = [],
    raws: Raw[] = [],
    pending: { statement: string; callback: (error: unknown, result: unknown) => void }[] = [];
  const control = {
    ready: 1 as unknown,
    profile: "app_help_chat_v1",
    libraryUpdate: false,
    missingLibrary: false,
    extraGrant: false,
    missingGrant: false,
    hangAcquire: false,
    hangEnd: false,
    failObserver: false,
    hang: (_statement: string) => false,
    fail: (_statement: string): unknown => undefined,
  };
  const rawObservers: (() => void)[] = [];
  let acquire: Parameters<Pool["getConnection"]>[0] | undefined,
    poolObserver: (() => void) | undefined;
  function rawConnection(): Raw {
    const raw: Raw & { on: (event: string, callback: () => void) => void } = {
      query: vi.fn((statement, _parameters, callback) => {
        statements.push(statement);
        if (control.hang(statement)) {
          pending.push({ statement, callback });
          return;
        }
        const error = control.fail(statement);
        if (error) {
          callback(error, undefined);
          return;
        }
        let result: unknown = header;
        if (statement.startsWith("SELECT CURRENT_USER"))
          result = [
            {
              account: "qa_api@%",
              login_user: "qa_api@172.20.0.2",
              database_name: "qa",
              active_role: null,
              server_version: "11.4.13-MariaDB-ubu2404",
              ssl_cipher: "TLS_AES_256_GCM_SHA384",
              applicable_roles: 0,
              enabled_roles: "0",
            },
          ];
        if (statement === "SHOW GRANTS FOR CURRENT_USER")
          result = [
            {
              grant:
                "GRANT USAGE ON *.* TO `qa_api`@`%` IDENTIFIED BY PASSWORD '*" +
                "A".repeat(40) +
                "' REQUIRE SSL",
            },
            ...(control.missingGrant
              ? appGrantRows(control.profile).slice(1)
              : appGrantRows(control.profile)
            ).filter(
              (row) =>
                !control.missingLibrary ||
                !row.grant.includes("DELETE ON `qa`.`teacher_library_items`"),
            ),
            ...(control.libraryUpdate
              ? [{ grant: "GRANT UPDATE ON `qa`.`teacher_library_items` TO `qa_api`@`%`" }]
              : []),
            ...(control.extraGrant
              ? [
                  {
                    grant: "GRANT SELECT ON `qa`.`worker_security_audit_lock_keys` TO `qa_api`@`%`",
                  },
                ]
              : []),
          ];
        if (statement === "SHOW GRANTS FOR PUBLIC") result = [];
        if (statement.trim() === "SELECT 1 AS api_role_ready") result = [{ api_role_ready: 1 }];
        if (statement.trim() === "SELECT 1 AS ready") result = [{ ready: control.ready }];
        callback(null, result);
      }),
      release: vi.fn(),
      destroy: vi.fn(),
      on(_event, callback) {
        rawObservers.push(callback);
      },
    };
    raws.push(raw);
    return raw;
  }
  const end = vi.fn((callback: (error: unknown) => void) => {
    if (!control.hangEnd) callback(null);
  });
  const pool: Pool & { on: (event: string, callback: () => void) => void } = {
    getConnection(callback) {
      if (control.hangAcquire) acquire = callback;
      else callback(null, rawConnection());
    },
    end,
    on(_event, callback) {
      if (control.failObserver) throw new Error("private observer failure");
      poolObserver = callback;
    },
  };
  const factory = vi.fn<MariaDbPoolFactory>(() => pool);
  return {
    factory,
    control,
    statements,
    raws,
    pending,
    end,
    observer: () => poolObserver?.(),
    rawError: (index: number) => rawObservers[index]?.(),
    lateConnection: () => {
      const raw = rawConnection();
      acquire?.(null, raw);
      return raw;
    },
  };
}
function safeError(error: unknown) {
  expect(error).toMatchObject({ code: "API_MARIADB_DATABASE_FAILED" });
  expect(String(error) + JSON.stringify(error)).not.toMatch(
    /private|PASSWORD|SHOW GRANTS|qa_api|qa\.invalid|SELECT/iu,
  );
  expect(error).not.toHaveProperty("cause");
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("isolated MariaDB api opener", () => {
  it("uses api-only attestation, mandatory TLS and existing UTC/RC reset with a five-second cap", async () => {
    const h = fixture(),
      database = await openApiMariaDbDatabase(h.factory, options);
    expect(h.factory).toHaveBeenCalledWith(
      expect.objectContaining({
        connectTimeout: 5000,
        timezone: "Z",
        dateStrings: true,
        bigNumberStrings: true,
        multipleStatements: false,
        ssl: { ca: options.sslCa, rejectUnauthorized: true, verifyIdentity: true },
      }),
    );
    expect(requiredMariaDbRuntimeGrants("app", "app_mail_management_v1")).toHaveLength(262);
    expect(requiredMariaDbRuntimeGrants("app", "app_poll_close_v1")).toEqual(
      [
        ...requiredMariaDbRuntimeGrants("app", "app_mail_management_v1")!,
        "table|polls|UPDATE|closed_at",
        "table|polls|UPDATE|row_version",
      ].sort(),
    );
    expect(requiredMariaDbRuntimeGrants("app", "app_push_subscriptions_v1")).toEqual(
      [
        ...requiredMariaDbRuntimeGrants("app", "app_poll_close_v1")!,
        "table|push_subscriptions|DELETE|*",
        "table|push_subscriptions|INSERT|*",
        "table|push_subscriptions|SELECT|*",
        "table|push_subscriptions|UPDATE|auth_secret",
        "table|push_subscriptions|UPDATE|p256dh",
        "table|push_subscriptions|UPDATE|updated_at",
        "table|push_subscriptions|UPDATE|user_id",
      ].sort(),
    );
    expect(requiredMariaDbRuntimeGrants("app", "app_push_deliveries_v1")).toEqual(
      [
        ...requiredMariaDbRuntimeGrants("app", "app_push_subscriptions_v1")!,
        "table|push_deliveries|DELETE|*",
        "table|push_deliveries|INSERT|*",
        "table|push_deliveries|SELECT|*",
        "table|push_deliveries|UPDATE|accepted_count",
        "table|push_deliveries|UPDATE|completed_at",
        "table|push_deliveries|UPDATE|failed_count",
        "table|push_deliveries|UPDATE|removed_count",
        "table|push_deliveries|UPDATE|status",
      ].sort(),
    );
    expect(requiredMariaDbRuntimeGrants("app", "app_schedule_links_v1")).toEqual(
      [
        ...requiredMariaDbRuntimeGrants("app", "app_push_deliveries_v1")!,
        "table|schedule_notice_links|DELETE|*",
        "table|schedule_notice_links|INSERT|*",
        "table|schedule_notice_links|SELECT|*",
        "table|schedule_supply_links|DELETE|*",
        "table|schedule_supply_links|INSERT|*",
        "table|schedule_supply_links|SELECT|*",
      ].sort(),
    );
    expect(requiredMariaDbRuntimeGrants("app", "app_help_requests_v1")).toEqual(
      [
        ...requiredMariaDbRuntimeGrants("app", "app_schedule_links_v1")!,
        "table|help_requests|INSERT|*",
        "table|help_requests|SELECT|*",
        "table|help_requests|UPDATE|closed_at",
        "table|help_requests|UPDATE|reply",
        "table|help_requests|UPDATE|status",
      ].sort(),
    );
    expect(requiredMariaDbRuntimeGrants("app", "app_help_chat_v1")).toEqual(
      [
        ...requiredMariaDbRuntimeGrants("app", "app_help_requests_v1")!,
        "table|help_request_messages|INSERT|*",
        "table|help_request_messages|SELECT|*",
      ].sort(),
    );
    expect(h.statements[0]).toBe("SET SESSION max_statement_time = 5");
    expect(h.statements).toContain("SET SESSION time_zone = '+00:00'");
    expect(h.statements).toContain("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
    expect(h.statements).toContain("SHOW GRANTS FOR CURRENT_USER");
    expect(h.statements).toContain("SHOW GRANTS FOR PUBLIC");
    expect(h.statements.at(-1)).toBe("ROLLBACK");
    expect(h.end).not.toHaveBeenCalled();
    await assertApiMariaDbDatabaseRole(database);
    expect(
      h.statements.filter((statement) => statement === "SHOW GRANTS FOR CURRENT_USER"),
    ).toHaveLength(2);
    await database.destroy();
    expect(h.end).toHaveBeenCalledOnce();
  });
  it("rejects excess privileges and closes the pool without exposing native identity details", async () => {
    const h = fixture();
    h.control.extraGrant = true;
    const error: unknown = await openApiMariaDbDatabase(h.factory, options).catch(
      (error: unknown) => error,
    );
    safeError(error);
    expect(error).toMatchObject({ reason: "role" });
    expect(h.raws[0]!.destroy).toHaveBeenCalledOnce();
    expect(h.end).toHaveBeenCalledOnce();
  });
  it("attests the installed-extension profile: a DB without the passkey grants is refused", async () => {
    // 픽스처 DB에는 도움 대화 기반 권한만 있다. 패스키가 "설치됨"이라고 하면 정확히 일치하지 않아 막혀야 한다.
    const h = fixture();
    const error: unknown = await openApiMariaDbDatabase(h.factory, options, undefined, {
      auth: "passkeys",
      classChat: false,
    }).catch((error: unknown) => error);
    safeError(error);
    expect(error).toMatchObject({ reason: "role" });
    expect(h.statements).not.toContain("SELECT 1 AS api_role_ready");
  });
  it("rejects a missing app privilege before the role probe", async () => {
    const h = fixture();
    h.control.missingGrant = true;
    const error: unknown = await openApiMariaDbDatabase(h.factory, options).catch(
      (error: unknown) => error,
    );
    safeError(error);
    expect(error).toMatchObject({ reason: "role" });
    expect(h.statements).not.toContain("SELECT 1 AS api_role_ready");
    expect(h.end).toHaveBeenCalledOnce();
  });
  it("rejects a worker grant profile injected by an untyped caller before pool creation", async () => {
    const h = fixture();
    const error: unknown = await openApiMariaDbDatabase(h.factory, {
      ...options,
      ...{ runtimeGrantProfile: "worker_security_audit_v1" },
    }).catch((error: unknown) => error);
    safeError(error);
    expect(error).toMatchObject({ reason: "configuration" });
    expect(h.factory).not.toHaveBeenCalled();
  });
  it("contains constructor validation failures before pool creation", async () => {
    const h = fixture();
    const error: unknown = await openApiMariaDbDatabase(h.factory, {
      ...options,
      host: "127.0.0.1",
    }).catch((error: unknown) => error);
    safeError(error);
    expect(h.factory).not.toHaveBeenCalled();
  });
  it("re-attests every new lease and rejects pooled privilege drift before business SQL", async () => {
    const h = fixture(),
      database = await openApiMariaDbDatabase(h.factory, options);
    h.control.extraGrant = true;
    await expect(assertApiMariaDbDatabaseRole(database)).rejects.toMatchObject({
      reason: "role",
    });
    expect(
      h.statements.filter((statement) => statement.trim() === "SELECT 1 AS api_role_ready"),
    ).toHaveLength(1);
    await database.destroy();
  });
  it("passes a no-argument pool observer and contains observer exceptions", async () => {
    const h = fixture(),
      observer = vi.fn(() => {
        throw new Error("private observer payload");
      });
    const database = await openApiMariaDbDatabase(h.factory, options, observer);
    expect(() => h.observer()).not.toThrow();
    expect(observer).toHaveBeenCalledWith();
    expect(() => h.rawError(0)).not.toThrow();
    expect(observer).toHaveBeenCalledTimes(2);
    expect(h.raws[0]!.destroy).toHaveBeenCalledOnce();
    await database.destroy();
  });
  it("closes a pool whose observer registration fails", async () => {
    const h = fixture();
    h.control.failObserver = true;
    const error: unknown = await openApiMariaDbDatabase(h.factory, options).catch(
      (error: unknown) => error,
    );
    safeError(error);
    expect(h.raws).toHaveLength(0);
    expect(h.end).toHaveBeenCalledOnce();
  });
});

describe("MariaDB api readiness transaction", () => {
  it("sets only its lease to one second, waits for COMMIT, then restores five seconds on a later ordinary lease", async () => {
    const h = fixture(),
      database = await openApiMariaDbDatabase(h.factory, options);
    h.control.hang = (statement) => statement === "COMMIT";
    let completed = false;
    const task = probeApiMariaDbReadiness(database).then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    expect(completed).toBe(false);
    expect(h.pending[0]!.statement).toBe("COMMIT");
    expect(h.statements).toContain("SET SESSION max_statement_time = 1");
    expect(h.statements).toContain("START TRANSACTION READ WRITE");
    expect(h.statements).toContain("SELECT 1 AS ready");
    h.pending[0]!.callback(null, header);
    await task;
    h.control.hang = () => false;
    await assertApiMariaDbDatabaseRole(database);
    expect(
      h.statements.filter((statement) => statement.startsWith("SET SESSION max_statement_time")),
    ).toEqual([
      "SET SESSION max_statement_time = 5",
      "SET SESSION max_statement_time = 1",
      "SET SESSION max_statement_time = 5",
    ]);
    await database.destroy();
  });
  it("does not leak readiness scope into concurrent ordinary leases", async () => {
    const h = fixture(),
      database = await openApiMariaDbDatabase(h.factory, options);
    h.control.hang = (statement) => statement.trim() === "SELECT 1 AS ready";
    const task = probeApiMariaDbReadiness(database);
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    await assertApiMariaDbDatabaseRole(database);
    expect(
      h.statements
        .filter((statement) => statement.startsWith("SET SESSION max_statement_time"))
        .at(-1),
    ).toBe("SET SESSION max_statement_time = 5");
    h.pending[0]!.callback(null, [{ ready: 1 }]);
    await task;
    await database.destroy();
  });
  it.each([0, "1", null])(
    "rolls back unexpected readiness result %o before returning",
    async (ready) => {
      const h = fixture(),
        database = await openApiMariaDbDatabase(h.factory, options),
        start = h.statements.length;
      h.control.ready = ready;
      const error: unknown = await probeApiMariaDbReadiness(database).catch(
        (error: unknown) => error,
      );
      safeError(error);
      expect(error).toMatchObject({ reason: "readiness" });
      expect(h.statements.slice(start)).not.toContain("COMMIT");
      expect(h.statements.at(-1)).toBe("ROLLBACK");
      await database.destroy();
    },
  );
  it("contains native probe failures and ends the transaction before reuse", async () => {
    const h = fixture(),
      database = await openApiMariaDbDatabase(h.factory, options);
    h.control.fail = (statement) =>
      statement.trim() === "SELECT 1 AS ready"
        ? new Error("private-password private SQL")
        : undefined;
    const error: unknown = await probeApiMariaDbReadiness(database).catch(
      (error: unknown) => error,
    );
    safeError(error);
    expect(h.statements.at(-1)).toBe("ROLLBACK");
    h.control.fail = () => undefined;
    await probeApiMariaDbReadiness(database);
    await database.destroy();
  });
  it("does not report readiness after a lost COMMIT acknowledgement", async () => {
    const h = fixture(),
      database = await openApiMariaDbDatabase(h.factory, options);
    h.control.fail = (statement) =>
      statement === "COMMIT" ? new Error("private commit acknowledgement lost") : undefined;
    const error: unknown = await probeApiMariaDbReadiness(database).catch(
      (error: unknown) => error,
    );
    safeError(error);
    expect(error).toMatchObject({ reason: "readiness" });
    expect(h.raws[1]!.destroy).toHaveBeenCalledOnce();
    expect(h.raws[1]!.release).not.toHaveBeenCalled();
    await database.destroy();
  });
  it("rejects databases lacking this adapter's timeout bootstrap", async () => {
    const database = {} as ApiMariaDbDatabase;
    await expect(probeApiMariaDbReadiness(database)).rejects.toMatchObject({
      reason: "readiness",
    });
    await expect(assertApiMariaDbDatabaseRole(database)).rejects.toMatchObject({
      reason: "role",
    });
  });
});

describe("MariaDB api client deadlines and resource cleanup", () => {
  it("bounds a hung pool acquisition and discards a late socket", async () => {
    vi.useFakeTimers();
    const h = fixture();
    h.control.hangAcquire = true;
    const outcome = openApiMariaDbDatabase(h.factory, options).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5000);
    safeError(await outcome);
    const raw = h.lateConnection();
    expect(raw.destroy).toHaveBeenCalledOnce();
    expect(raw.release).not.toHaveBeenCalled();
    expect(h.end).toHaveBeenCalledOnce();
  });
  it("bounds a hung bootstrap and ignores its late callback", async () => {
    vi.useFakeTimers();
    const h = fixture();
    h.control.hang = (statement) => statement.startsWith("SET SESSION max_statement_time");
    const outcome = openApiMariaDbDatabase(h.factory, options).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5000);
    safeError(await outcome);
    expect(h.raws[0]!.destroy).toHaveBeenCalledOnce();
    h.pending[0]!.callback(null, header);
    expect(h.statements).toHaveLength(1);
    expect(h.raws[0]!.release).not.toHaveBeenCalled();
  });
  it("bounds general queries at five seconds and never returns the uncertain socket to the pool", async () => {
    vi.useFakeTimers();
    const h = fixture(),
      database = await openApiMariaDbDatabase(h.factory, options);
    h.control.hang = (statement) => statement.includes("api_timeout_probe");
    const outcome = sql`SELECT 1 AS api_timeout_probe`
      .execute(database)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5000);
    safeError(await outcome);
    expect(h.raws[1]!.destroy).toHaveBeenCalledOnce();
    expect(h.raws[1]!.release).not.toHaveBeenCalled();
    h.pending[0]!.callback(null, [{ api_timeout_probe: 1 }]);
    await database.destroy();
  });
  it("bounds failed opener cleanup and suppresses its native error", async () => {
    vi.useFakeTimers();
    const h = fixture();
    h.control.extraGrant = true;
    h.control.hangEnd = true;
    const outcome = openApiMariaDbDatabase(h.factory, options).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5000);
    const error = await outcome;
    safeError(error);
    expect(error).toMatchObject({ reason: "cleanup" });
    expect(h.raws[0]!.destroy).toHaveBeenCalledOnce();
    expect(h.end).toHaveBeenCalledOnce();
  });
});

const fullInstalled = {
  auth: "all" as const,
  classChat: true,
  profilePhotos: true,
  birthDates: true,
  adminAccessLogs: true,
  pollEdit: true,
  teacherLibrary: true,
};
const fullLibraryProfile =
  "app_class_chat_photos_passkeys_social_birthdates_accesslogs_polledit_teacherlibrary_v1";
describe("installed teacher library exact app ACL", () => {
  it("opens the full installed profile with exactly three library grants", async () => {
    const f = fixture();
    f.control.profile = fullLibraryProfile;
    const db = await openApiMariaDbDatabase(f.factory, options, undefined, fullInstalled);
    await probeApiMariaDbReadiness(db);
    await db.destroy();
  });
  it.each(["missing", "update", "unselected"])("rejects %s library ACL", async (kind) => {
    const f = fixture();
    f.control.profile = fullLibraryProfile;
    f.control.missingLibrary = kind === "missing";
    f.control.libraryUpdate = kind === "update";
    await expect(
      openApiMariaDbDatabase(f.factory, options, undefined, {
        ...fullInstalled,
        teacherLibrary: kind !== "unselected",
      }),
    ).rejects.toMatchObject({ reason: "role" });
    expect(f.end).toHaveBeenCalledOnce();
  });
});
