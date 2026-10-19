const messages = {
  OPERATOR_INVALID_INPUT: "이관 요청 정보가 올바르지 않습니다.",
  OPERATOR_UNAUTHENTICATED: "운영자 인증을 확인해 주세요.",
  OPERATOR_CLASS_NOT_FOUND: "해당 학급을 찾을 수 없습니다.",
  OPERATOR_CLASS_NOT_LIVE: "현재 학급 상태에서는 담임을 이관할 수 없습니다.",
  OPERATOR_SAME_TEACHER: "현재 담임과 같은 교사에게는 이관할 수 없습니다.",
  OPERATOR_OUTGOING_USER_NOT_FOUND: "현재 담임의 계정을 찾을 수 없습니다.",
  OPERATOR_OUTGOING_MEMBERSHIP_CHANGED:
    "현재 담임 정보가 변경되었습니다. 학급 상태를 확인해 주세요.",
  OPERATOR_TARGET_PRIOR_MEMBERSHIP:
    "받을 교사는 이 학급의 과거 구성원입니다. 별도 교사 계정을 사용해 주세요.",
  OPERATOR_TARGET_CURRENT_MEMBERSHIP: "받을 교사는 이미 소속 학급이 있어 이관할 수 없습니다.",
  OPERATOR_TARGET_NOT_TEACHER: "받을 대상이 교사 계정이 아닙니다.",
  OPERATOR_OUTGOING_CAS_FAILED: "현재 담임 정보가 변경되어 이관을 완료하지 못했습니다.",
  OPERATOR_CLASS_REACTIVATION_CAS_FAILED: "학급 상태가 변경되어 재활성화를 완료하지 못했습니다.",
  OPERATOR_INCOMING_USER_NOT_FOUND: "받을 교사의 계정을 찾을 수 없습니다.",
  OPERATOR_INCOMING_USER_INACTIVE: "받을 교사의 계정이 비활성 상태입니다.",
  OPERATOR_INCOMING_PROFILE_INACTIVE: "받을 교사의 교사 권한이 비활성 상태입니다.",
  OPERATOR_TEMPORARY_PASSWORD_UNCHANGED: "받을 교사가 임시 비밀번호를 먼저 변경해야 합니다.",
  OPERATOR_EXPECTED_VERSION_REQUIRED: "학급의 최신 버전 정보가 필요합니다.",
  OPERATOR_CLASS_VERSION_CHANGED: "학급 정보가 변경되었습니다. 최신 상태를 확인해 주세요.",
  OPERATOR_TRANSFER_BUSY:
    "다른 작업과 충돌하여 이관을 완료하지 못했습니다. 학급 상태를 확인해 주세요.",
  OPERATOR_TRANSFER_FAILED: "학급 이관을 완료하지 못했습니다. 처리 결과를 확인해 주세요.",
} as const;

type TransferCode = keyof typeof messages;
const issuedErrors = new WeakSet<object>();

/** Only fixed messages are accepted; no native error, SQL, connection string or cause is retained. */
export class MariaDbTransferError extends Error {
  readonly code: string;

  constructor(code: string) {
    const safeCode: TransferCode = Object.hasOwn(messages, code)
      ? (code as TransferCode)
      : "OPERATOR_TRANSFER_FAILED";
    super(messages[safeCode]);
    this.name = "MariaDbTransferError";
    this.code = safeCode;
    issuedErrors.add(this);
    Object.freeze(this);
  }
}

// Operation-scoped: invoke for transfer_class_teacher_checked, not unrelated CALLs.
// The source contract explicitly makes 30508/30509 public OPERATOR_* CAS codes.
const signals = new Map<number, readonly [sqlState: string, code: TransferCode]>([
  [30002, ["45000", "OPERATOR_CLASS_NOT_FOUND"]],
  [30501, ["45000", "OPERATOR_CLASS_NOT_LIVE"]],
  [30502, ["45000", "OPERATOR_SAME_TEACHER"]],
  [30503, ["45000", "OPERATOR_OUTGOING_USER_NOT_FOUND"]],
  [30504, ["45000", "OPERATOR_OUTGOING_MEMBERSHIP_CHANGED"]],
  [30505, ["45000", "OPERATOR_TARGET_PRIOR_MEMBERSHIP"]],
  [30506, ["45000", "OPERATOR_TARGET_CURRENT_MEMBERSHIP"]],
  [30507, ["45000", "OPERATOR_TARGET_NOT_TEACHER"]],
  [30508, ["45000", "OPERATOR_OUTGOING_CAS_FAILED"]],
  [30509, ["45000", "OPERATOR_CLASS_REACTIVATION_CAS_FAILED"]],
  [30510, ["45000", "OPERATOR_INCOMING_USER_NOT_FOUND"]],
  [30511, ["45000", "OPERATOR_INCOMING_USER_INACTIVE"]],
  [30512, ["45000", "OPERATOR_INCOMING_PROFILE_INACTIVE"]],
  [30513, ["45000", "OPERATOR_TEMPORARY_PASSWORD_UNCHANGED"]],
  [30514, ["22023", "OPERATOR_EXPECTED_VERSION_REQUIRED"]],
  [30515, ["40001", "OPERATOR_CLASS_VERSION_CHANGED"]],
  [1213, ["40001", "OPERATOR_TRANSFER_BUSY"]],
  [1205, ["HY000", "OPERATOR_TRANSFER_BUSY"]],
]);

/** Classifies diagnostics only. The caller owns complete rollback; this never retries. */
export function mapMariaDbTransferError(error: unknown): MariaDbTransferError {
  try {
    if (typeof error === "object" && error !== null && !Array.isArray(error)) {
      if (issuedErrors.has(error)) return error as MariaDbTransferError;
      // mysql2 supplies own data properties. Do not invoke accessors or inspect causes/messages.
      const errno: unknown = Object.getOwnPropertyDescriptor(error, "errno")?.value;
      const sqlState: unknown = Object.getOwnPropertyDescriptor(error, "sqlState")?.value;
      if (typeof errno === "number" && Number.isInteger(errno) && typeof sqlState === "string") {
        const mapping = signals.get(errno);
        if (mapping && mapping[0] === sqlState) return new MariaDbTransferError(mapping[1]);
      }
    }
  } catch {
    // An unknown object can also be a revoked/throwing proxy. Keep that failure private.
  }
  return new MariaDbTransferError("OPERATOR_TRANSFER_FAILED");
}
