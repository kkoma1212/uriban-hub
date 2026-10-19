import type { SecurityAuditEvent } from "@classhub/db";

/** Storage boundary only; Redis retry, acknowledgement and retention remain worker-owned. */
export interface SecurityAuditStore {
  insertEvent(event: SecurityAuditEvent): Promise<void>;
  isEventAlreadyHandled(event: SecurityAuditEvent): Promise<boolean>;
}
