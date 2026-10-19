/** Explicitly selected by the MariaDB API provider; an omitted option preserves PG behavior. */
export const MARIA_DB_SESSION_OPTIONS = Symbol("MARIA_DB_SESSION_OPTIONS");

export interface MariaDbSessionOptions {
  dialect: "mariadb";
}
