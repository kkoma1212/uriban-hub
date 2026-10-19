import { adminFetch as apiFetch } from "./admin-request";
import { parseAdminResponse, readAdminCsrfCookie } from "./admin-auth";

export interface SignupMailTemplate {
  title: string;
  introduction: string;
  footer: string;
  button_label: string;
}
export interface MailManagementState {
  template: SignupMailTemplate;
  approvals: Array<{
    id: string;
    recipient_email: string;
    role: "student" | "teacher";
    code: string | null;
    status: "active" | "consumed" | "revoked" | "expired";
    expires_at: string;
    issued_at: string;
  }>;
  deliveries: Array<{
    id: string;
    recipient_email: string;
    subject: string;
    status: "pending" | "accepted" | "failed";
    failure_code: string | null;
    created_at: string;
    completed_at: string | null;
  }>;
}

export async function getMailManagement(email = ""): Promise<MailManagementState> {
  return parseAdminResponse(
    await apiFetch(`/api/v1/admin/mail${email ? `?email=${encodeURIComponent(email)}` : ""}`, {
      credentials: "include",
    }),
  );
}
export async function saveMailTemplate(template: SignupMailTemplate): Promise<void> {
  await parseAdminResponse(
    await apiFetch("/api/v1/admin/mail/template", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-Admin-CSRF": readAdminCsrfCookie() },
      body: JSON.stringify(template),
    }),
  );
}
export async function resendAdminSignupMail(
  email: string,
  role: "student" | "teacher",
): Promise<{ email_delivery_status: "sent" | "failed" }> {
  return parseAdminResponse(
    await apiFetch("/api/v1/admin/mail/resend", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-Admin-CSRF": readAdminCsrfCookie() },
      body: JSON.stringify({ email, role }),
    }),
  );
}
