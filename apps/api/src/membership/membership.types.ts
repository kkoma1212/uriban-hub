export interface CreateMembershipRequestCommand {
  clientIp: string;
  inviteCode: string;
  requestId: string;
  userId: string;
}

export interface CreateMembershipRequestResult {
  class_id: string;
  email_delivery_status?: "failed" | "sent";
  teacher_notification_delivery_status?: "failed" | "sent";
  membership_id: string;
  next_action: "BOOTSTRAP";
  row_version: string;
  status: "pending";
}

export interface OwnMembershipTransitionCommand {
  requestId: string;
  userId: string;
}

export interface OwnMembershipTransitionResult {
  class_id: string;
  membership_id: string;
  next_action: "BOOTSTRAP";
  row_version: string;
  status: "canceled" | "left";
  status_changed_at: Date;
}
