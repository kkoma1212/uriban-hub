export interface AccountAccessApproval {
  email_verified_at: Date | null;
  signup_approved_at: Date | null;
  signup_role?: string | null;
}

export function hasApprovedAccountAccess(account: AccountAccessApproval): boolean {
  if (account.signup_role === "teacher" && account.signup_approved_at === null) return false;
  return (
    account.email_verified_at !== null ||
    (account.signup_approved_at !== null && account.signup_approved_at !== undefined)
  );
}
