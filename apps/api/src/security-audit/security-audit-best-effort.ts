import type { SecurityAuditEvent } from "@classhub/db";

import type { SecurityAuditPublisher } from "./security-audit.types.js";

export async function publishSecurityAuditBestEffort(
  publisher: SecurityAuditPublisher,
  event: SecurityAuditEvent,
): Promise<void> {
  try {
    await publisher.publish(event);
  } catch {
    // Security-audit transport failures must never change the product decision.
  }
}
