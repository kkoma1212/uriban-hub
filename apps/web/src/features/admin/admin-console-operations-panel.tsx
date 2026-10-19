import { AlertTriangle, CheckCircle2, DatabaseBackup, RefreshCw, ServerCog } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type * as React from "react";

import { getAdminOperationsStatus, type AdminOperationsStatus } from "../../api/admin-operations";
import { ClientErrorsSection } from "./admin-console-client-errors";
import { adminErrorMessage, formatDateTime, LoadState, PanelFrame } from "./admin-console-shared";

// 백업은 6시간마다 돈다(OPERATIONS backup-policy). 30분 여유를 넘기면 늦은 것으로 본다.
const BACKUP_LATE_MS = 6.5 * 60 * 60 * 1000;
// PC 밖(USB) 반출은 주 1회(P-021). 7일이 넘었거나 한 번도 없으면 주의로 보인다.
const OFFLINE_BACKUP_LATE_MS = 7 * 24 * 60 * 60 * 1000;

function elapsed(at: string, now: string): string {
  const minutes = Math.max(0, Math.floor((Date.parse(now) - Date.parse(at)) / 60_000));
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}시간 전` : `${Math.floor(hours / 24)}일 전`;
}

function Row({
  attention = false,
  label,
  value,
}: {
  attention?: boolean;
  label: string;
  value: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-app-border py-2 first:border-t-0">
      <dt className="shrink-0 whitespace-nowrap text-sm text-app-muted">{label}</dt>
      <dd
        className={
          "text-right text-sm font-bold tabular-nums " +
          (attention ? "text-danger-text" : "text-app-text")
        }
      >
        {attention ? <AlertTriangle aria-hidden="true" className="mr-1 inline" size={14} /> : null}
        {value}
      </dd>
    </div>
  );
}

function Section({
  children,
  icon: Icon,
  title,
}: {
  children: React.ReactNode;
  icon: typeof ServerCog;
  title: string;
}): React.JSX.Element {
  return (
    <section className="rounded-card border border-app-border bg-app-surface p-4">
      <h3 className="flex items-center gap-2 text-sm font-extrabold text-app-text">
        <Icon aria-hidden="true" size={17} /> {title}
      </h3>
      <dl className="mt-2">{children}</dl>
    </section>
  );
}

const Unavailable = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <p className="mt-2 rounded-2xl bg-app-surface-muted px-3 py-3 text-sm font-semibold text-app-muted">
    {children}
  </p>
);

type AuditQueue = NonNullable<AdminOperationsStatus["audit_queue"]>;

/**
 * 격리가 모두 운영자가 확인한 시각 이전 것이면 '확인한 과거 격리'다(2026-09-30 사용자 결정:
 * 9/9 전환 때 130건은 보존·구분). 그 뒤 새 격리가 생기면 다시 경고한다.
 */
function quarantineReviewed(queue: AuditQueue): boolean {
  return (
    (queue.quarantine_entries ?? 0) > 0 &&
    queue.latest_quarantined_at !== null &&
    queue.quarantine_reviewed_through !== null &&
    Date.parse(queue.latest_quarantined_at) <= Date.parse(queue.quarantine_reviewed_through)
  );
}

function auditStatusText(queue: AuditQueue): { attention: boolean; text: string } {
  // 확인한 과거 격리 말고 다른 사유가 없으면 정상으로 본다.
  if (
    queue.status === "attention" &&
    quarantineReviewed(queue) &&
    queue.conditions.every((condition) => condition === "quarantine_present")
  )
    return { attention: false, text: "정상 (확인한 과거 격리만)" };
  return { attention: queue.status !== "ok", text: AUDIT_STATUS_TEXT[queue.status] };
}

function quarantineText(queue: AuditQueue): { attention: boolean; text: string } {
  const entries = queue.quarantine_entries;
  if (entries === null) return { attention: true, text: "알 수 없음" };
  if (entries === 0) return { attention: false, text: "0건" };
  const latest =
    queue.latest_quarantined_at === null ? "" : formatDateTime(queue.latest_quarantined_at);
  if (quarantineReviewed(queue))
    return { attention: false, text: `${entries}건 · 확인한 과거 건(마지막 ${latest})` };
  return {
    attention: true,
    text: latest === "" ? `${entries}건` : `${entries}건 · 새 격리 있음(마지막 ${latest})`,
  };
}

const AUDIT_STATUS_TEXT = {
  attention: "확인 필요",
  degraded: "처리 지연",
  ok: "정상",
  unknown: "알 수 없음",
} as const;

/** 운영 상태(2026-09-30): 감사 기록 격리 수·백업·복원 검증(=DB 설치 상태). 읽기 전용. */
export function OperationsPanel(): React.JSX.Element {
  const [status, setStatus] = useState<AdminOperationsStatus>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      setStatus(await getAdminOperationsStatus());
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "운영 상태를 불러오지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const noSource = "이 서버에는 백업 상태 폴더가 설정되지 않아 확인할 수 없습니다.";

  return (
    <PanelFrame
      description="보안 감사 기록 처리, 백업, 복원 검증 결과를 숫자와 시각으로만 봅니다. 바꾸는 기능은 없습니다."
      icon={ServerCog}
      title="운영 상태"
    >
      <LoadState
        error={error}
        loading={loading && status === undefined}
        onRetry={() => void load()}
      />
      {status === undefined ? null : (
        <>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-app-muted">
            <span>{formatDateTime(status.generated_at)} 기준</span>
            <button
              aria-busy={loading}
              className="ui-button ui-button-secondary text-xs"
              disabled={loading}
              onClick={() => void load()}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={15} /> 새로 보기
            </button>
          </div>
          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            <Section icon={ServerCog} title="보안 감사 기록 처리">
              {status.audit_queue === null ? (
                <Unavailable>
                  작업자에 연결할 수 없습니다. 작업자가 꺼져 있을 수 있습니다.
                </Unavailable>
              ) : (
                <>
                  <Row
                    attention={auditStatusText(status.audit_queue).attention}
                    label="상태"
                    value={auditStatusText(status.audit_queue).text}
                  />
                  <Row
                    attention={quarantineText(status.audit_queue).attention}
                    label="격리된 기록"
                    value={quarantineText(status.audit_queue).text}
                  />
                  <Row
                    label="처리 대기"
                    value={
                      status.audit_queue.pending_entries === null
                        ? "알 수 없음"
                        : `${status.audit_queue.pending_entries}건`
                    }
                  />
                  <Row
                    label="확인 시각"
                    value={
                      status.audit_queue.sampled_at === null
                        ? "없음"
                        : formatDateTime(status.audit_queue.sampled_at)
                    }
                  />
                </>
              )}
            </Section>
            <Section icon={DatabaseBackup} title="백업">
              {status.backup === null ? (
                <Unavailable>
                  {status.status_source_configured ? "백업 기록을 읽을 수 없습니다." : noSource}
                </Unavailable>
              ) : (
                <>
                  <Row
                    attention={!status.backup.verified}
                    label="검증"
                    value={status.backup.verified ? "암호화·되읽기 확인됨" : "검증 안 됨"}
                  />
                  <Row label="마지막 백업" value={formatDateTime(status.backup.at)} />
                  <Row
                    attention={
                      Date.parse(status.generated_at) - Date.parse(status.backup.at) >
                      BACKUP_LATE_MS
                    }
                    label="지난 시간"
                    value={elapsed(status.backup.at, status.generated_at)}
                  />
                </>
              )}
              {status.status_source_configured ? (
                <Row
                  attention={
                    status.offline_backup === null ||
                    Date.parse(status.generated_at) - Date.parse(status.offline_backup.at) >
                      OFFLINE_BACKUP_LATE_MS
                  }
                  label="PC 밖 반출(USB)"
                  value={
                    status.offline_backup === null
                      ? "아직 없음"
                      : `${formatDateTime(status.offline_backup.at)} (${elapsed(status.offline_backup.at, status.generated_at)})`
                  }
                />
              ) : null}
            </Section>
            <Section icon={CheckCircle2} title="복원 검증·DB 설치 상태">
              {status.restore_check === null ? (
                <Unavailable>
                  {status.status_source_configured
                    ? "복원 검증 기록을 읽을 수 없습니다."
                    : noSource}
                </Unavailable>
              ) : (
                <>
                  <Row
                    attention={!status.restore_check.passed}
                    label="격리 복원"
                    value={status.restore_check.passed ? "통과" : "실패"}
                  />
                  <Row
                    attention={status.restore_check.tables !== status.restore_check.expected_tables}
                    label="표"
                    value={`${status.restore_check.tables} / ${status.restore_check.expected_tables}`}
                  />
                  <Row
                    attention={
                      status.restore_check.ledger_rows !== status.restore_check.expected_ledger_rows
                    }
                    label="설치 원장"
                    value={`${status.restore_check.ledger_rows} / ${status.restore_check.expected_ledger_rows}`}
                  />
                  <Row
                    label="검증 시각"
                    value={`${formatDateTime(status.restore_check.at)} (${elapsed(status.restore_check.at, status.generated_at)})`}
                  />
                </>
              )}
            </Section>
          </div>
          <ClientErrorsSection refreshKey={status.generated_at} />
          <p className="mt-3 text-xs leading-5 text-app-muted">
            격리된 기록은 저장에 실패해 따로 보관된 보안 감사 기록입니다. DB 설치 상태는 실시간 값이
            아니라 마지막 복원 검증 때 확인한 값입니다.
          </p>
        </>
      )}
    </PanelFrame>
  );
}
