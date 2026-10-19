export interface PasswordResetRequestContext {
  clientIp: string;
  requestId: string;
  userAgent: string | undefined;
}

export interface PasswordResetRequestResult {
  request_accepted: true;
}

export interface ConfirmPasswordResetResult {
  next_action: "LOGIN";
  password_reset: true;
}
