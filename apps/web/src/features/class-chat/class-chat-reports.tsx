import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ApiRequestError } from "../../api/auth";
import { AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT } from "../../lib/authenticated-client-state";

import {
  hideClassChatMessage,
  listClassChatReports,
  resolveClassChatReport,
  type ClassChatReport,
} from "../../api/class-chat";

function errorMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : "처리하지 못했어요.";
}

/** 담임에게만: 처리하지 않은 신고를 보고, 메시지를 가리거나 처리 완료로 둔다. */
export function ClassChatReportsPanel({
  onChanged,
}: {
  onChanged: () => Promise<unknown>;
}): React.JSX.Element {
  const [reports, setReports] = useState<ClassChatReport[]>();
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const navigate = useNavigate();
  const lifetime = useRef({ mounted: false, epoch: 0, busy: false });
  useEffect(() => {
    lifetime.current.mounted = true;
    const invalidate = () => {
      lifetime.current.mounted = false;
      lifetime.current.epoch += 1;
    };
    window.addEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, invalidate);
    return () => {
      invalidate();
      window.removeEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, invalidate);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const epoch = lifetime.current.epoch;
    const isCurrent = () => active && lifetime.current.mounted && lifetime.current.epoch === epoch;
    if (!isCurrent()) return;
    setError(undefined);
    void listClassChatReports()
      .then((items) => {
        if (isCurrent()) setReports(items);
      })
      .catch((failure: unknown) => {
        if (isCurrent() && failure instanceof ApiRequestError && failure.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        if (isCurrent()) setError(errorMessage(failure));
      });
    return () => {
      active = false;
    };
  }, [attempt, navigate]);

  async function handle(report: ClassChatReport, hide: boolean): Promise<void> {
    if (!lifetime.current.mounted || lifetime.current.busy) return;
    lifetime.current.busy = true;
    const epoch = lifetime.current.epoch;
    const isCurrent = () => lifetime.current.mounted && lifetime.current.epoch === epoch;
    setBusyId(report.id);
    setError(undefined);
    try {
      if (hide && !report.message.hidden) await hideClassChatMessage(report.message.id);
      if (!isCurrent()) return;
      await resolveClassChatReport(report.id);
      if (!isCurrent()) return;
      await onChanged();
      if (!isCurrent()) return;
      setAttempt((value) => value + 1);
    } catch (failure) {
      if (!isCurrent()) return;
      if (failure instanceof ApiRequestError && failure.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      setError(errorMessage(failure));
    } finally {
      if (!isCurrent()) return;
      lifetime.current.busy = false;
      setBusyId(undefined);
    }
  }

  return (
    <section aria-label="신고된 메시지" className="class-chat-reports" data-class-chat-reports>
      {error ? (
        <p className="help-action-error" role="alert">
          {error}
        </p>
      ) : null}
      {reports === undefined ? (
        <p className="p-2 text-sm text-app-muted">신고를 불러오고 있어요.</p>
      ) : reports.length === 0 ? (
        <p className="p-2 text-sm text-app-muted">처리할 신고가 없어요.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {reports.map((report) => (
            <li className="class-chat-report" key={report.id}>
              <p className="text-xs text-app-muted">
                {report.reporter.name}님이 신고 · {report.reason}
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                <strong>{report.message.author.name}</strong>: {report.message.body}
                {report.message.hidden ? " (가려짐)" : ""}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {!report.message.hidden ? (
                  <button
                    className="ui-button ui-button-primary text-sm"
                    disabled={busyId !== undefined}
                    onClick={() => void handle(report, true)}
                    type="button"
                  >
                    가리고 처리
                  </button>
                ) : null}
                <button
                  className="ui-button ui-button-secondary text-sm"
                  disabled={busyId !== undefined}
                  onClick={() => void handle(report, false)}
                  type="button"
                >
                  문제없음으로 처리
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
