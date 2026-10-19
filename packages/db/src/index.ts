export { createDatabase } from "./connection.js";
export type { DatabaseConnectionOptions } from "./connection.js";
export { createMariaDbDatabase, parseMariaDbTlsMode } from "./mariadb/connection.js";
export type {
  MariaDbConnectionOptions,
  MariaDbPoolConfiguration,
  MariaDbPoolFactory,
  MariaDbTlsMode,
} from "./mariadb/connection.js";
export { MariaDbRuntimeRoleError } from "./mariadb/runtime-role.js";
export type { MariaDbRuntimeRole } from "./mariadb/runtime-role.js";
export {
  requiredMariaDbRuntimeGrants,
  selectAppRuntimeGrantProfile,
  type MariaDbAuthDatabaseExtensions,
  type MariaDbRuntimeGrantProfile,
} from "./mariadb/runtime-grant-extensions.js";
export { boundedMariaDbPoolFactory, WorkerMariaDbDatabaseError } from "./mariadb/bounded-pool.js";
export type { MariaDbPoolFailureReason } from "./mariadb/bounded-pool.js";
export {
  MariaDbIdempotencyService,
  MariaDbIdempotencyError,
} from "./mariadb/idempotency.service.js";
export {
  createMariaDbWorkerAuditLockManager,
  MariaDbWorkerAuditLockError,
} from "./mariadb/worker-audit-lock.js";
export type {
  PreparedWorkerAuditLock,
  MariaDbWorkerAuditLockManager,
} from "./mariadb/worker-audit-lock.js";
export {
  matchesDatabaseConstraint,
  postgresDatabaseErrorClassifier,
} from "./database-error-classifier.js";
export type {
  ClassifiedDatabaseError,
  DatabaseConstraintExpectation,
  DatabaseErrorClassifier,
  DatabaseErrorKind,
} from "./database-error-classifier.js";
export type {
  DB,
  DB as Database,
  GuardianConsentRequests,
  JsonObject,
  JsonValue,
} from "./generated/database.js";
export { ADMIN_ROLES, isAdminRole } from "./admin-auth.js";
export type { AdminRole } from "./admin-auth.js";
export { assertProductionDatabaseUrl } from "./production-database-url.js";
export type { ProductionDatabaseUrlOptions } from "./production-database-url.js";
export {
  assertPostgresRuntimeRole,
  POSTGRES_RUNTIME_ROLE_ATTESTATION_ERROR,
  PostgresRuntimeRoleAttestationError,
} from "./postgres-runtime-role.js";
export type {
  PostgresRuntimeRoleAttestationFailureReason,
  PostgresRuntimeRoleAttestationOptions,
} from "./postgres-runtime-role.js";
export { createPostgresTransactionLockManager } from "./transaction-lock.js";
export type { TransactionLockManager, TransactionLockMode } from "./transaction-lock.js";
export { hashPassword, passwordNeedsRehash, verifyPassword } from "./password-hasher.js";
export { PasswordWorkCapacityError } from "./password-work-limiter.js";
export {
  LEGACY_PASSWORD_INPUT_VERSION,
  NFC_PASSWORD_INPUT_VERSION,
  passwordForVerification,
} from "./password-input-version.js";
export type { PasswordInputVersion } from "./password-input-version.js";
export {
  createIdempotencyRequestHash,
  createIdempotencyRouteKey,
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
  IdempotencyService,
  InvalidIdempotencyKeyError,
  materializeOptionalFields,
  normalizeIdempotencyKey,
  serializeCanonicalRequest,
} from "./idempotency/index.js";
export type {
  CanonicalJson,
  IdempotencyExecutionResult,
  IdempotencyRequest,
  IdempotencyServiceOptions,
  IdempotencySuccess,
} from "./idempotency/index.js";
export {
  SECURITY_AUDIT_AUTHORIZATION_DEDUP_WINDOW_MS,
  SECURITY_AUDIT_CSRF_DEDUP_WINDOW_MS,
  SECURITY_AUDIT_RATE_LIMIT_DEDUP_WINDOW_MS,
  securityAuditDeduplicationScope,
} from "./security-audit/dedup.js";
export type { SecurityAuditDeduplicationScope } from "./security-audit/dedup.js";
export {
  parseSecurityAuditEvent,
  SECURITY_AUDIT_ACTIONS,
  SECURITY_AUDIT_CONSUMER_GROUP,
  SECURITY_AUDIT_DEAD_LETTER_INDEX,
  SECURITY_AUDIT_DEAD_LETTER_STREAM,
  SECURITY_AUDIT_EVENT_FIELD,
  SECURITY_AUDIT_EVENT_ID_FIELD,
  SECURITY_AUDIT_OCCURRED_AT_FIELD,
  SECURITY_AUDIT_STREAM,
  sanitizeSecurityAuditUserAgent,
  serializeSecurityAuditEvent,
  validateSecurityAuditEvent,
} from "./security-audit/event.js";
export type { SecurityAuditAction, SecurityAuditEvent } from "./security-audit/event.js";
export { isRetryableSerializationError, withSerializationRetry } from "./transaction-retry.js";
export type { SerializationRetryOptions } from "./transaction-retry.js";
export { createMysql2MariaDbPool } from "./mariadb/mysql2-pool.js";
export { parseMariaDbUrl } from "./mariadb/connection-url.js";

export type {
  MariaDbRuntimeObservation,
  MariaDbRuntimeObservationSink,
  MariaDbRuntimeTlsState,
} from "./mariadb/runtime-observation.js";

export { createConfiguredRuntimeObservation } from "./mariadb/configured-runtime-observation.js";
export {
  runtimeInspectionHoldMs,
  hasRuntimeObservationSettings,
  holdRuntimeObservationForInspection,
} from "./mariadb/runtime-inspection-window.js";
export type {
  ConfiguredRuntimeObservation,
  MariaDbRuntimeObservationComponent,
  RuntimeObservationDependencies,
  RuntimeObservationFileSystem,
} from "./mariadb/configured-runtime-observation.js";
