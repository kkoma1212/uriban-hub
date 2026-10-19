export interface ChangePasswordCommand {
  clientIp: string;
  currentPassword: string;
  newPassword: string;
  sessionId: string;
  userId: string;
}

export interface ChangePasswordResult {
  next_action: "LOGIN";
  password_changed: true;
}

export interface UpdateAccountProfileCommand {
  displayName: string;
  sessionId: string;
  userId: string;
}

export interface UpdateAccountProfileResult {
  display_name: string;
  profile_updated: boolean;
  updated_at: string;
}

export interface DeleteAccountCommand {
  clientIp: string;
  confirmation: string;
  currentPassword: string;
  requestId: string;
  sessionId: string;
  userAgent: string | undefined;
  userId: string;
}

export interface DeleteAccountResult {
  account_deleted: true;
  next_action: "LOGIN";
}
