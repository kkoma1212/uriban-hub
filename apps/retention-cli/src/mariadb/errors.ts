export class RetentionMariaDbError extends Error {
  readonly code = "RETENTION_MARIADB_FAILED";
  constructor(readonly reason: string) {
    super("Retention MariaDB operation could not be completed.");
    this.name = "RetentionMariaDbError";
  }
}
