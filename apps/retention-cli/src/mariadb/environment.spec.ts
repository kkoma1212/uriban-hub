import { describe, expect, it } from "vitest";
import { loadRetentionEnvironment } from "../environment.js";

const url = "mariadb://classhub_retention:synthetic%2Fsecret@db.internal/classhub";
const input = {
  DATABASE_ENGINE: "mariadb",
  RETENTION_DATABASE_URL: url,
  RETENTION_DATABASE_TLS_CA_FILE: "/synthetic/ca.pem",
  RETENTION_DATABASE_ACCOUNT_HOST: "%",
};
describe("retention MariaDB environment", () => {
  it("requires an explicit reviewed archive profile and its preceding ACL chain", () => {
    expect(() =>
      loadRetentionEnvironment({ ...input, RETENTION_CLASS_ARCHIVES_GRANT_INSTALLED: "active" }),
    ).toThrow("requires RETENTION_ADMIN_RECORDS");
    expect(() =>
      loadRetentionEnvironment({ ...input, RETENTION_CLASS_ARCHIVES_GRANT_INSTALLED: "true" }),
    ).toThrow("must be none, active or legacy");
    const installed = {
      ...input,
      RETENTION_MAIL_LOGS_GRANT_INSTALLED: "true",
      RETENTION_AUDIT_CONSENTS_GRANT_INSTALLED: "true",
      RETENTION_ADMIN_RECORDS_GRANT_INSTALLED: "true",
    };
    for (const profile of ["active", "legacy"])
      expect(
        loadRetentionEnvironment({
          ...installed,
          RETENTION_CLASS_ARCHIVES_GRANT_INSTALLED: profile,
        }).mariaDb?.classArchivesGrantProfile,
      ).toBe(profile);
  });
  it("requires explicit MariaDB selection and the strict account/DNS/CA/host contract", () => {
    expect(loadRetentionEnvironment(input)).toEqual({
      databaseEngine: "mariadb",
      databaseUrl: url,
      nodeEnvironment: "development",
      mariaDb: {
        tlsCaFile: "/synthetic/ca.pem",
        tls: "required",
        accountHost: "%",
        connectionLimit: 10,
        mailLogsGrantInstalled: false,
        auditConsentsGrantInstalled: false,
        adminRecordsGrantInstalled: false,
        classArchivesGrantProfile: "none",
      },
    });
    expect(
      loadRetentionEnvironment({
        ...input,
        NODE_ENV: "production",
        RETENTION_DATABASE_POOL_MAX: "1",
      }).mariaDb?.connectionLimit,
    ).toBe(1);
  });
  it("turns on the mail log grant set only for an explicit true (I5-04)", () => {
    expect(
      loadRetentionEnvironment({ ...input, RETENTION_MAIL_LOGS_GRANT_INSTALLED: "true" }).mariaDb
        ?.mailLogsGrantInstalled,
    ).toBe(true);
    expect(() =>
      loadRetentionEnvironment({ ...input, RETENTION_MAIL_LOGS_GRANT_INSTALLED: "yes" }),
    ).toThrow("RETENTION_MAIL_LOGS_GRANT_INSTALLED");
  });
  it("stacks the audit/consent grant switch on the mail switch (I3-01)", () => {
    expect(
      loadRetentionEnvironment({
        ...input,
        RETENTION_MAIL_LOGS_GRANT_INSTALLED: "true",
        RETENTION_AUDIT_CONSENTS_GRANT_INSTALLED: "true",
      }).mariaDb?.auditConsentsGrantInstalled,
    ).toBe(true);
    expect(() =>
      loadRetentionEnvironment({ ...input, RETENTION_AUDIT_CONSENTS_GRANT_INSTALLED: "true" }),
    ).toThrow("requires RETENTION_MAIL_LOGS_GRANT_INSTALLED");
  });
  it("stacks the admin record grant set only on the audit set (2026-10-04)", () => {
    const audit = {
      ...input,
      RETENTION_MAIL_LOGS_GRANT_INSTALLED: "true",
      RETENTION_AUDIT_CONSENTS_GRANT_INSTALLED: "true",
    };
    expect(
      loadRetentionEnvironment({ ...audit, RETENTION_ADMIN_RECORDS_GRANT_INSTALLED: "true" })
        .mariaDb?.adminRecordsGrantInstalled,
    ).toBe(true);
    expect(loadRetentionEnvironment(audit).mariaDb?.adminRecordsGrantInstalled).toBe(false);
    expect(() =>
      loadRetentionEnvironment({ ...input, RETENTION_ADMIN_RECORDS_GRANT_INSTALLED: "true" }),
    ).toThrow("requires RETENTION_AUDIT_CONSENTS_GRANT_INSTALLED");
    expect(() =>
      loadRetentionEnvironment({ ...audit, RETENTION_ADMIN_RECORDS_GRANT_INSTALLED: "1" }),
    ).toThrow("RETENTION_ADMIN_RECORDS_GRANT_INSTALLED must be true or false");
  });
  it("preserves decoded valid account names", () => {
    expect(
      loadRetentionEnvironment({
        ...input,
        RETENTION_DATABASE_URL: url.replace("classhub_retention", "classhub%5Fretention"),
      }).databaseEngine,
    ).toBe("mariadb");
  });
  it.each(["", "sqlite", "MariaDB"])("rejects engine %s", (DATABASE_ENGINE) => {
    expect(() => loadRetentionEnvironment({ ...input, DATABASE_ENGINE })).toThrow(
      "DATABASE_ENGINE",
    );
  });
  it.each(["", "0", "-1", "01", "1.5", "1e2", "1001"])(
    "rejects pool bound %s",
    (RETENTION_DATABASE_POOL_MAX) => {
      expect(() => loadRetentionEnvironment({ ...input, RETENTION_DATABASE_POOL_MAX })).toThrow(
        "RETENTION_DATABASE_POOL_MAX",
      );
    },
  );
  it.each([undefined, "", " "])("requires CA %s", (RETENTION_DATABASE_TLS_CA_FILE) => {
    expect(() => loadRetentionEnvironment({ ...input, RETENTION_DATABASE_TLS_CA_FILE })).toThrow(
      "RETENTION_DATABASE_TLS_CA_FILE",
    );
  });
  it.each([undefined, "", "host name", "user@host"])(
    "requires account host %s",
    (RETENTION_DATABASE_ACCOUNT_HOST) => {
      expect(() => loadRetentionEnvironment({ ...input, RETENTION_DATABASE_ACCOUNT_HOST })).toThrow(
        "RETENTION_DATABASE_ACCOUNT_HOST",
      );
    },
  );
  it.each([
    url.replace("classhub_retention", "classhub_app"),
    url.replace("db.internal", "127.0.0.1"),
    url.replace("db.internal", "[::1]"),
    url.replace("mariadb:", "postgresql:"),
    `${url}?ssl=false`,
    `${url}?multipleStatements=true`,
    `${url}?sslmode=verify-full`,
    url.replace("synthetic%2Fsecret", "private%FFsecret"),
  ])(
    "rejects incompatible MariaDB URL without private diagnostics: %s",
    (RETENTION_DATABASE_URL) => {
      let error: unknown;
      try {
        loadRetentionEnvironment({ ...input, RETENTION_DATABASE_URL });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String(error) + JSON.stringify(error)).not.toMatch(
        /private|synthetic|db.internal|127.0.0.1|URIError/u,
      );
      expect(error).not.toHaveProperty("cause");
    },
  );
  it("keeps default PostgreSQL and its production verify-full and role requirements", () => {
    const pg = {
      NODE_ENV: "production",
      RETENTION_DATABASE_URL:
        "postgresql://classhub_retention:synthetic@db.internal/classhub?sslmode=verify-full",
    };
    expect(loadRetentionEnvironment(pg)).toMatchObject({ databaseEngine: "postgres" });
    expect(() =>
      loadRetentionEnvironment({
        ...pg,
        RETENTION_DATABASE_URL: pg.RETENTION_DATABASE_URL.replace("verify-full", "disable"),
      }),
    ).toThrow("canonical sslmode=verify-full");
    expect(() =>
      loadRetentionEnvironment({
        ...pg,
        RETENTION_DATABASE_URL: pg.RETENTION_DATABASE_URL.replace(
          "classhub_retention",
          "classhub_app",
        ),
      }),
    ).toThrow("classhub_retention role");
  });
});
