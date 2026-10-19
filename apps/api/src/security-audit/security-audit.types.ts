import type { SecurityAuditEvent } from "@classhub/db";

export interface SecurityAuditPublisher {
  publish(event: SecurityAuditEvent): Promise<void>;
  close(): Promise<void>;
}

export interface SecurityAuditFallbackLogger {
  error(entry: {
    action: "security_audit.publish_failed";
    event_id: string;
    failure_code: "security_event_invalid" | "security_stream_unavailable";
    request_id: string;
  }): void;
}
