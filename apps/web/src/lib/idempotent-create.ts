import {
  ApiRequestError,
  NETWORK_ERROR_CODE,
  REQUEST_ABORTED_CODE,
  REQUEST_TIMEOUT_CODE,
} from "../api/auth";

const RETRY_WINDOW_MS = 23 * 60 * 60 * 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SERVER_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

interface StoredIdempotentCreateAttempt {
  idempotencyKey: string;
  request: unknown;
  serverDate: string | undefined;
  startedAt: number;
  version: 1 | 2;
}

export interface IdempotentCreateAttempt<TRequest> {
  idempotencyKey: string;
  request: TRequest;
  serverDate: string | undefined;
  startedAt: number;
}

export type IdempotentCreatePreparation<TRequest> =
  | { attempt: IdempotentCreateAttempt<TRequest>; kind: "ready"; reused: boolean }
  | { attempt: IdempotentCreateAttempt<unknown>; kind: "expired" }
  | { attempt: IdempotentCreateAttempt<unknown>; kind: "mismatch" }
  | { kind: "storage-unavailable" };

function sessionStorageOrUndefined(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function readStoredAttempt(storageKey: string): StoredIdempotentCreateAttempt | undefined {
  const storage = sessionStorageOrUndefined();
  if (storage === undefined) return undefined;

  let raw: string | null;
  try {
    raw = storage.getItem(storageKey);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;

  try {
    const value = JSON.parse(raw) as Partial<StoredIdempotentCreateAttempt>;
    if (
      (value.version !== 1 && value.version !== 2) ||
      typeof value.idempotencyKey !== "string" ||
      !UUID_PATTERN.test(value.idempotencyKey) ||
      (value.serverDate !== undefined &&
        (typeof value.serverDate !== "string" || !SERVER_DATE_PATTERN.test(value.serverDate))) ||
      typeof value.startedAt !== "number" ||
      !Number.isFinite(value.startedAt) ||
      value.startedAt < 0 ||
      value.request === undefined
    ) {
      storage.removeItem(storageKey);
      return undefined;
    }
    return value as StoredIdempotentCreateAttempt;
  } catch {
    try {
      storage.removeItem(storageKey);
    } catch {
      // Storage access is optional. The in-memory attempt still protects the active page.
    }
    return undefined;
  }
}

function writeStoredAttempt(
  storageKey: string,
  attempt: IdempotentCreateAttempt<unknown>,
): boolean {
  const storage = sessionStorageOrUndefined();
  if (storage === undefined) return false;
  try {
    const serialized = JSON.stringify({
      ...attempt,
      version: 2,
    } satisfies StoredIdempotentCreateAttempt);
    storage.setItem(storageKey, serialized);
    return storage.getItem(storageKey) === serialized;
  } catch {
    return false;
  }
}

export function idempotentCreateStorageKey(resource: string, membershipId: string): string {
  return `classhub:idempotent-create:${resource}:${membershipId}`;
}

export function readIdempotentCreateAttempt<TRequest>(
  storageKey: string,
  isRequest: (value: unknown) => value is TRequest,
): IdempotentCreateAttempt<TRequest> | undefined {
  const stored = readStoredAttempt(storageKey);
  if (stored === undefined) return undefined;
  if (!isRequest(stored.request)) {
    clearIdempotentCreateAttempt(storageKey);
    return undefined;
  }
  return {
    idempotencyKey: stored.idempotencyKey,
    request: stored.request,
    serverDate: stored.serverDate,
    startedAt: stored.startedAt,
  };
}

function prepareAttempt<TRequest>(
  storageKey: string,
  request: TRequest,
  serverDate: string | undefined,
  currentAttempt?: IdempotentCreateAttempt<TRequest>,
  now = Date.now(),
): IdempotentCreatePreparation<TRequest> {
  const stored = readStoredAttempt(storageKey) ?? currentAttempt;
  if (stored !== undefined) {
    const existing: IdempotentCreateAttempt<unknown> = {
      idempotencyKey: stored.idempotencyKey,
      request: stored.request,
      serverDate: stored.serverDate,
      startedAt: stored.startedAt,
    };
    if (
      serverDate !== undefined &&
      (existing.serverDate === undefined || existing.serverDate !== serverDate)
    ) {
      return { attempt: existing, kind: "expired" };
    }
    if (JSON.stringify(existing.request) !== JSON.stringify(request)) {
      return { attempt: existing, kind: "mismatch" };
    }
    if (now < existing.startedAt || now - existing.startedAt >= RETRY_WINDOW_MS) {
      return { attempt: existing, kind: "expired" };
    }
    if (!writeStoredAttempt(storageKey, existing)) return { kind: "storage-unavailable" };
    return {
      attempt: existing as IdempotentCreateAttempt<TRequest>,
      kind: "ready",
      reused: true,
    };
  }

  const attempt: IdempotentCreateAttempt<TRequest> = {
    idempotencyKey: crypto.randomUUID(),
    request,
    serverDate,
    startedAt: now,
  };
  if (!writeStoredAttempt(storageKey, attempt)) return { kind: "storage-unavailable" };
  return { attempt, kind: "ready", reused: false };
}

export function prepareIdempotentCreateAttempt<TRequest>(
  storageKey: string,
  request: TRequest,
  currentAttempt?: IdempotentCreateAttempt<TRequest>,
  now = Date.now(),
): IdempotentCreatePreparation<TRequest> {
  return prepareAttempt(storageKey, request, undefined, currentAttempt, now);
}

export function prepareServerDatedIdempotentCreateAttempt<TRequest>(
  storageKey: string,
  request: TRequest,
  serverDate: string,
  currentAttempt?: IdempotentCreateAttempt<TRequest>,
  now = Date.now(),
): IdempotentCreatePreparation<TRequest> {
  if (!SERVER_DATE_PATTERN.test(serverDate)) return { kind: "storage-unavailable" };
  return prepareAttempt(storageKey, request, serverDate, currentAttempt, now);
}

export function persistIdempotentCreateAttempt<TRequest>(
  storageKey: string,
  attempt: IdempotentCreateAttempt<TRequest>,
): boolean {
  const stored = readStoredAttempt(storageKey);
  if (stored !== undefined && stored.idempotencyKey !== attempt.idempotencyKey) return false;
  return writeStoredAttempt(storageKey, attempt);
}

export function clearIdempotentCreateAttempt(
  storageKey: string,
  expectedIdempotencyKey?: string,
): void {
  const storage = sessionStorageOrUndefined();
  if (storage === undefined) return;
  try {
    if (expectedIdempotencyKey !== undefined) {
      const stored = readStoredAttempt(storageKey);
      if (stored === undefined || stored.idempotencyKey !== expectedIdempotencyKey) return;
    }
    storage.removeItem(storageKey);
  } catch {
    // Clearing best-effort storage must not block navigation or an explicit cancel.
  }
}

export function isMutationOutcomeUnknown(error: unknown): boolean {
  return (
    !(error instanceof ApiRequestError) ||
    // A network failure means the request may or may not have reached the
    // server. Treating it as a definite failure would clear the idempotency
    // attempt and allow a duplicate create on retry.
    error.code === NETWORK_ERROR_CODE ||
    error.code === REQUEST_ABORTED_CODE ||
    error.code === REQUEST_TIMEOUT_CODE ||
    error.code === "UNEXPECTED_RESPONSE" ||
    error.status === 408 ||
    error.status >= 500
  );
}

export function unknownMutationResultMessage(action: string): string {
  return `${action}이 저장됐는지 확인하지 못했어요. 입력은 그대로 두었어요. ‘결과 다시 확인’을 누르면 두 번 저장되지 않고 결과를 볼 수 있어요.`;
}

export function expiredMutationResultMessage(action: string): string {
  return `${action}을 다시 확인할 수 있는 시간이 지났어요. 두 번 저장되지 않도록 다시 보내지 않았어요. 목록에서 저장됐는지 확인하고, 안 됐으면 문의해 주세요.`;
}

export function changedMutationResultMessage(): string {
  return "결과를 확인하지 못한 이전 요청과 입력이 다릅니다. 이전 입력으로 저장 결과를 먼저 확인해 주세요.";
}

export function unavailableMutationStorageMessage(): string {
  return "이 브라우저에 임시 정보를 저장할 수 없어 보내지 않았어요. 브라우저 설정에서 사이트 데이터 저장을 허용한 뒤 다시 시도해 주세요.";
}

export function unavailableMutationAuthorityMessage(action: string): string {
  return `${action}을 보내도 되는지 확인하지 못해 보내지 않았어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.`;
}
