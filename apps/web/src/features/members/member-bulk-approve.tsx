import { CheckCheck, LoaderCircle } from "lucide-react";
import { useRef, useState } from "react";

import { approveMember, type MemberListItem } from "../../api/auth";
import { isMutationOutcomeUnknown } from "../../lib/idempotent-create";
import { confirmMemberTransition } from "./member-transition-recovery";
import { codePointLength } from "../../lib/text";
import { ConfirmDialog } from "../layout/confirm-dialog";

export interface ApprovalDraft {
  displayName: string;
  studentNumber: string;
}

export type ApprovalRequest =
  | { ok: true; request: { display_name_in_class: string | null; student_number: number | null } }
  | { ok: false; message: string };

/** 한 명 승인과 일괄 승인이 같은 입력 규칙을 쓰도록 한 곳에 둔다. */
export function approvalRequestFromDraft(draft: ApprovalDraft): ApprovalRequest {
  const trimmedName = draft.displayName.trim();
  const nameLength = codePointLength(trimmedName);
  const studentNumber = draft.studentNumber === "" ? null : Number(draft.studentNumber);
  if (
    studentNumber !== null &&
    (!Number.isInteger(studentNumber) || studentNumber < 1 || studentNumber > 99)
  ) {
    return { ok: false, message: "학생 번호는 1부터 99 사이로 입력해 주세요." };
  }
  if (nameLength === 1 || nameLength > 20) {
    return { ok: false, message: "반에서 보이는 이름은 비워 두거나 2~20자로 입력해 주세요." };
  }
  return {
    ok: true,
    request: {
      display_name_in_class: trimmedName === "" ? null : trimmedName,
      student_number: studentNumber,
    },
  };
}

export interface BulkApproveResult {
  approved: number;
  unconfirmed?: string[];
  mailUnknown?: number;
  mailFailed: number;
  failed: { name: string; message: string }[];
}

interface MemberBulkApproveProps {
  pending: MemberListItem[];
  drafts: Record<string, ApprovalDraft | undefined>;
  disabled: boolean;
  onRunningChange?: (running: boolean) => void;
  onFinished: (result: BulkApproveResult) => Promise<void> | void;
}

/*
 * 새 학기 첫날 30명을 한 명씩 승인하지 않도록, 대기 학생을 차례로 승인한다.
 * 서버에는 기존 한 명 승인 요청을 그대로 보낸다(권한·중복 번호 검사가 한 곳에 남는다).
 * 한 명이 실패해도 나머지는 계속 승인하고, 끝나면 실패한 학생과 이유를 모아 알린다.
 */
export function MemberBulkApprove({
  pending,
  drafts,
  disabled,
  onFinished,
  onRunningChange,
}: MemberBulkApproveProps): React.JSX.Element | null {
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<number>();
  const progressFocusRef = useRef<HTMLDivElement>(null);
  const runningRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // 승인할 수 없는(비활성) 계정은 처음부터 빼고 센다 — '5명 승인'에 1명이 실패로 섞였다(총검수 A1-06).
  const approvable = pending.filter((member) => member.account_state !== "inactive");
  const skipped = pending.length - approvable.length;
  if (approvable.length < 2) return null;

  async function approveAll(): Promise<void> {
    if (runningRef.current || disabled) return;
    runningRef.current = true;
    onRunningChange?.(true);
    try {
      const result: BulkApproveResult = { approved: 0, mailFailed: 0, failed: [] };
      const targets = [...approvable];
      for (const [index, member] of targets.entries()) {
        setProgress(index + 1);
        const draft = drafts[member.id] ?? { displayName: "", studentNumber: "" };
        const prepared = approvalRequestFromDraft(draft);
        if (!prepared.ok) {
          result.failed.push({ name: member.display_name, message: prepared.message });
          continue;
        }
        try {
          const response = await approveMember(member.id, prepared.request);
          result.approved += 1;
          if (response.email_delivery_status === "failed") result.mailFailed += 1;
        } catch (error) {
          if (await confirmMemberTransition(error, member.id, "approved")) {
            result.approved += 1;
            result.mailUnknown = (result.mailUnknown ?? 0) + 1;
            continue;
          }
          if (isMutationOutcomeUnknown(error)) {
            (result.unconfirmed ??= []).push(member.display_name);
            continue;
          }
          result.failed.push({
            name: member.display_name,
            message: error instanceof Error ? error.message : "승인하지 못했습니다.",
          });
        }
      }
      await onFinished(result);
    } finally {
      runningRef.current = false;
      setProgress(undefined);
      onRunningChange?.(false);
    }
  }

  const running = progress !== undefined;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center justify-end gap-2"
      ref={progressFocusRef}
      tabIndex={-1}
    >
      <p className="sr-only">입력한 번호·이름이 있으면 그대로 쓰고, 없으면 번호 없이 승인합니다.</p>
      <button
        aria-busy={running}
        className="ui-button ui-button-primary min-h-11 text-sm"
        data-member-bulk-approve="true"
        disabled={disabled || running}
        onClick={() => setConfirming(true)}
        ref={triggerRef}
        type="button"
      >
        {running ? (
          <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
        ) : (
          <CheckCheck aria-hidden="true" size={17} />
        )}
        {running
          ? `승인 중 ${progress}/${approvable.length}`
          : `대기 학생 모두 승인 (${approvable.length}명${skipped > 0 ? `, 비활성 ${skipped}명 제외` : ""})`}
      </button>
      <ConfirmDialog
        confirmLabel={`${approvable.length}명 승인`}
        confirmTone="primary"
        fallbackFocusTo={progressFocusRef.current}
        description={`대기 중인 학생을 모두 반에 들어오게 합니다.${skipped > 0 ? ` 사용이 정지된 계정 ${skipped}명은 승인할 수 없어 뺐어요.` : ""} 모르는 학생이 섞여 있지 않은지 목록을 먼저 확인해 주세요. 승인한 뒤에도 학생 관리에서 반에서 제외할 수 있습니다.`}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void approveAll();
        }}
        open={confirming}
        returnFocusTo={triggerRef.current}
        title={`대기 학생 ${approvable.length}명을 모두 승인할까요?`}
      />
    </div>
  );
}

export function bulkApproveSummary(result: BulkApproveResult): {
  notice?: string;
  error?: string;
} {
  const notice =
    result.approved === 0
      ? undefined
      : `${result.approved}명을 승인했습니다.` +
        (result.mailFailed > 0
          ? ` ${result.mailFailed}명에게는 안내 메일을 보내지 못했어요. 학생에게 결과를 알려 주세요.`
          : "") +
        ((result.mailUnknown ?? 0) > 0
          ? ` ${result.mailUnknown}명의 승인은 확인했지만 안내 메일이 갔는지는 확인하지 못했어요.`
          : "");
  const failure =
    result.failed.length === 0
      ? undefined
      : `${result.failed.length}명은 승인하지 못했습니다. ` +
        result.failed.map((failure) => `${failure.name}: ${failure.message}`).join(" / ");
  const uncertain =
    (result.unconfirmed?.length ?? 0) === 0
      ? undefined
      : `${result.unconfirmed!.length}명의 승인 결과를 확인하지 못했습니다. 최신 목록에서 상태를 확인해 주세요: ${result.unconfirmed!.join(" / ")}`;
  const error = [failure, uncertain].filter(Boolean).join(" ") || undefined;
  return { ...(notice ? { notice } : {}), ...(error ? { error } : {}) };
}
