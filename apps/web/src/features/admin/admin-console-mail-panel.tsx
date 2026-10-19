import { Copy, Mail, RefreshCw, Send } from "lucide-react";
import { useEffect, useState } from "react";
import {
  getMailManagement,
  resendAdminSignupMail,
  saveMailTemplate,
  type MailManagementState,
  type SignupMailTemplate,
} from "../../api/admin-mail";
import {
  adminErrorMessage,
  formatDateTime,
  InlineNotice,
  LoadState,
  PanelFrame,
} from "./admin-console-shared";
import { useRequestCooldown } from "../auth/request-cooldown";

const approvalStatus = {
  active: "인증 대기",
  consumed: "인증 완료",
  revoked: "사용 중지",
  expired: "만료",
};
const deliveryStatus = {
  pending: "처리 중 · 결과 확인 필요",
  accepted: "SMTP 접수 성공",
  failed: "발송 실패",
};
const failures: Record<string, string> = {
  authentication_failed: "발신 계정 인증 실패",
  recipient_rejected: "수신 주소 거절",
  connection_failed: "메일 서버 연결 실패",
  tls_failed: "보안 연결 실패",
  smtp_failed: "메일 서버 오류",
};

export function MailPanel(): React.JSX.Element {
  const [data, setData] = useState<MailManagementState>();
  const [draft, setDraft] = useState<SignupMailTemplate>();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const cooldown = useRequestCooldown();

  async function load(filter = email): Promise<void> {
    setLoading(true);
    setError(undefined);
    try {
      const result = await getMailManagement(filter.trim());
      setData(result);
      setDraft((current) => current ?? result.template);
    } catch (cause) {
      setError(adminErrorMessage(cause, "메일 관리 정보를 불러오지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load("");
  }, []);

  async function resend(address: string, role: "student" | "teacher"): Promise<void> {
    if (busy || cooldown > 0) return;
    setBusy(true);
    setNotice(undefined);
    setError(undefined);
    try {
      const result = await resendAdminSignupMail(address, role);
      setNotice(
        result.email_delivery_status === "sent"
          ? "인증번호 메일을 SMTP 서버가 접수했습니다."
          : "발송에 실패했습니다. 발송 내역의 사유를 확인해 주세요.",
      );
      await load();
    } catch (cause) {
      setError(adminErrorMessage(cause, "인증번호 메일을 보내지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelFrame
      icon={Mail}
      title="메일 관리"
      description="가입 인증번호, 수신 주소와 발송 결과를 확인하고 인증 메일 양식을 수정합니다."
    >
      <form
        className="mt-6 flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <label className="auth-label min-w-0 flex-1">
          수신 이메일로 검색
          <input
            className="ui-input mt-2"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="전체 주소"
          />
        </label>
        <button className="ui-button ui-button-secondary" disabled={loading} type="submit">
          <RefreshCw size={16} aria-hidden /> 새로고침
        </button>
      </form>
      <LoadState loading={loading && !data} error={error} onRetry={() => void load()} />
      {notice ? <InlineNotice>{notice}</InlineNotice> : null}
      {data ? (
        <div className="mt-6 space-y-8">
          <section>
            <h3 className="ui-section-title">가입 인증번호</h3>
            <p className="mt-2 text-sm leading-6 text-app-muted">
              메일에 보낸 번호와 동일합니다. 유효한 번호를 다시 보내면 번호가 유지됩니다. 만료된
              번호는 재발송할 때 새로 발급합니다.
            </p>
            <div
              aria-label="가입 인증번호 표"
              data-admin-table-scroll
              role="region"
              tabIndex={0}
              className="mt-4 overflow-x-auto rounded-card border border-app-line"
            >
              <table className="w-full min-w-[680px] text-left text-sm">
                <thead className="bg-app-surface-muted">
                  <tr>
                    {["이메일 · 유형", "인증번호", "상태 · 만료 시각", "발송"].map((label) => (
                      <th className="px-4 py-3 font-bold" key={label}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.approvals.map((item) => (
                    <tr className="border-t border-app-line" key={item.id}>
                      <td className="px-4 py-3">
                        <span className="break-all">{item.recipient_email}</span>
                        <span className="block text-app-muted">
                          {item.role === "student" ? "학생" : "선생님"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {item.code ? (
                          <div className="flex items-center gap-2">
                            <strong className="font-mono text-lg tracking-widest">
                              {item.code}
                            </strong>
                            <button
                              className="ui-button ui-button-ghost"
                              type="button"
                              aria-label={`${item.recipient_email} 인증번호 복사`}
                              onClick={() => {
                                void navigator.clipboard
                                  .writeText(item.code!)
                                  .then(() => setNotice("인증번호를 복사했습니다."))
                                  .catch(() =>
                                    setError(
                                      "복사하지 못했습니다. 표시된 번호를 직접 선택해 복사해 주세요.",
                                    ),
                                  );
                              }}
                            >
                              <Copy size={16} aria-hidden />
                            </button>
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {approvalStatus[item.status]}
                        <span className="block whitespace-nowrap text-app-muted">
                          {formatDateTime(item.expires_at)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {item.status === "active" || item.status === "expired" ? (
                          <button
                            className="ui-button ui-button-secondary whitespace-nowrap"
                            type="button"
                            disabled={busy || cooldown > 0}
                            onClick={() => void resend(item.recipient_email, item.role)}
                          >
                            <Send size={15} aria-hidden /> 다시 보내기
                          </button>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                  {data.approvals.length === 0 ? (
                    <tr>
                      <td className="p-5 text-app-muted" colSpan={4}>
                        표시할 인증번호가 없습니다.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
          <section>
            <h3 className="ui-section-title">발송 내역</h3>
            <p className="mt-2 text-sm leading-6 text-app-muted">
              최근 100건을 표시합니다. SMTP 접수 성공은 메일 서버가 접수했다는 뜻이며, 받은편지함
              도착 여부는 포함하지 않습니다.
            </p>
            <div
              aria-label="메일 발송 내역 표"
              data-admin-table-scroll
              role="region"
              tabIndex={0}
              className="mt-4 overflow-x-auto rounded-card border border-app-line"
            >
              <table className="w-full min-w-[680px] text-left text-sm">
                <thead className="bg-app-surface-muted">
                  <tr>
                    {["발송 시각", "받는 이메일", "제목", "발송 결과"].map((label) => (
                      <th className="px-4 py-3 font-bold" key={label}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.deliveries.map((item) => (
                    <tr className="border-t border-app-line" key={item.id}>
                      <td className="whitespace-nowrap px-4 py-3">
                        {formatDateTime(item.created_at)}
                      </td>
                      <td className="break-all px-4 py-3">{item.recipient_email}</td>
                      <td className="px-4 py-3">{item.subject}</td>
                      <td className="px-4 py-3">
                        <strong className={item.status === "failed" ? "text-danger-text" : ""}>
                          {deliveryStatus[item.status]}
                        </strong>
                        {item.failure_code ? (
                          <span className="block">
                            {failures[item.failure_code] ?? "발송 오류"}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {data.deliveries.length === 0 ? (
                    <tr>
                      <td className="p-5 text-app-muted" colSpan={4}>
                        기록된 발송 내역이 없습니다.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
          {draft ? (
            <form
              className="space-y-4 border-t border-app-line pt-6"
              onSubmit={(event) => {
                event.preventDefault();
                if (busy) return;
                setBusy(true);
                setError(undefined);
                setNotice(undefined);
                void saveMailTemplate(draft)
                  .then(() => setNotice("메일 양식을 저장했습니다. 다음 발송부터 적용됩니다."))
                  .catch((cause: unknown) =>
                    setError(adminErrorMessage(cause, "메일 양식을 저장하지 못했습니다.")),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              <h3 className="ui-section-title">가입 인증 메일 양식</h3>
              <p className="text-sm text-app-muted">
                6자리 인증번호와 사용 기한은 자동으로 포함됩니다.
              </p>
              <label className="auth-label block">
                메일 제목
                <input
                  className="ui-input mt-2"
                  required
                  maxLength={120}
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                />
              </label>
              <label className="auth-label block">
                안내 본문
                <textarea
                  className="ui-input mt-2 min-h-32"
                  required
                  maxLength={2000}
                  value={draft.introduction}
                  onChange={(event) => setDraft({ ...draft, introduction: event.target.value })}
                />
              </label>
              <label className="auth-label block">
                버튼 문구
                <input
                  className="ui-input mt-2"
                  required
                  maxLength={40}
                  value={draft.button_label}
                  onChange={(event) => setDraft({ ...draft, button_label: event.target.value })}
                />
              </label>
              <label className="auth-label block">
                하단 안내
                <textarea
                  className="ui-input mt-2 min-h-24"
                  required
                  maxLength={1000}
                  value={draft.footer}
                  onChange={(event) => setDraft({ ...draft, footer: event.target.value })}
                />
              </label>
              <button className="ui-button ui-button-primary" type="submit" disabled={busy}>
                {busy ? "처리 중…" : "메일 양식 저장"}
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
    </PanelFrame>
  );
}
