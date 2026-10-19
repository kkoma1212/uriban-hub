export interface LocalAdminLoginResult {
  csrfToken: string;
  expiresAt: Date;
  operatorId: string;
  sessionToken: string;
}

export interface LocalTestAccount {
  created_at: string;
  display_name: string;
  email: string;
  email_verified: boolean;
  id: string;
  membership_count: number;
  session_count: number;
}

export interface DeletedLocalTestAccount {
  deleted: true;
  deleted_counts: {
    consents: number;
    email_tokens: number;
    idempotency_keys: number;
    password_reset_tokens: number;
    sessions: number;
    users: 1;
  };
}
