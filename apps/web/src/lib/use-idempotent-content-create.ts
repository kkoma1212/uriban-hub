import { useEffect, useRef, useState } from "react";

import { ApiRequestError } from "../api/auth";
import {
  clearAuthenticatedClientState,
  AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT,
} from "./authenticated-client-state";
import {
  changedMutationResultMessage,
  clearIdempotentCreateAttempt,
  expiredMutationResultMessage,
  idempotentCreateStorageKey,
  type IdempotentCreateAttempt,
  isMutationOutcomeUnknown,
  persistIdempotentCreateAttempt,
  prepareServerDatedIdempotentCreateAttempt,
  readIdempotentCreateAttempt,
  unavailableMutationAuthorityMessage,
  unavailableMutationStorageMessage,
  unknownMutationResultMessage,
} from "./idempotent-create";

interface CreatedItemResponse {
  item: {
    id: string;
  };
}

export interface IdempotentContentCreateOptions<TRequest> {
  actionLabel: string;
  create: (request: TRequest, idempotencyKey: string) => Promise<CreatedItemResponse>;
  isRequest: (value: unknown) => value is TRequest;
  /** 아직 부트스트랩 전이면 undefined. 복원과 제출 모두 멤버십이 확정된 뒤에만 동작한다. */
  membershipId: string | undefined;
  onCreated: (itemId: string) => void;
  onUnauthorized: () => void;
  readServerToday: () => Promise<string>;
  resource: string;
  serverToday: string | undefined;
}

export interface IdempotentContentCreateState<TRequest> {
  busy: boolean;
  clearResolvedError: () => void;
  error: string | undefined;
  outcomeUnknown: boolean;
  pendingRequest: TRequest | undefined;
  submit: (request: TRequest) => Promise<void>;
}

/**
 * 공지·준비물·일정 페이지와 통합 알림 작성 패널이 공유하는 멱등 생성 흐름.
 * 결과를 알 수 없는 실패는 저장된 시도를 유지해 ‘결과 다시 확인’ 재시도가
 * 같은 Idempotency-Key로 나가게 하고, 확실한 실패만 시도를 지운다.
 */
export function useIdempotentContentCreate<TRequest>({
  actionLabel,
  create,
  isRequest,
  membershipId,
  onCreated,
  onUnauthorized,
  readServerToday,
  resource,
  serverToday,
}: IdempotentContentCreateOptions<TRequest>): IdempotentContentCreateState<TRequest> {
  const [busy, setBusy] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<TRequest>();
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [error, setError] = useState<string>();
  const busyRef = useRef(false);
  const attemptRef = useRef<IdempotentCreateAttempt<TRequest> | undefined>(undefined);
  const storageKey =
    membershipId === undefined ? undefined : idempotentCreateStorageKey(resource, membershipId);
  const contextRef = useRef({ storageKey, generation: 0 });
  if (contextRef.current.storageKey !== storageKey) {
    contextRef.current = {
      storageKey,
      generation: contextRef.current.generation + 1,
    };
  }
  const mountedRef = useRef(true);
  const authEpochRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    const clear = () => {
      authEpochRef.current += 1;
      contextRef.current = {
        ...contextRef.current,
        generation: contextRef.current.generation + 1,
      };
      attemptRef.current = undefined;
      busyRef.current = false;
      setBusy(false);
      setPendingRequest(undefined);
      setOutcomeUnknown(false);
      setError(undefined);
    };
    window.addEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, clear);
    return () => {
      mountedRef.current = false;
      window.removeEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, clear);
    };
  }, []);
  const unknownMessage = unknownMutationResultMessage(actionLabel);

  useEffect(() => {
    busyRef.current = false;
    setBusy(false);
  }, [storageKey]);

  useEffect(() => {
    attemptRef.current = undefined;
    setPendingRequest(undefined);
    setOutcomeUnknown(false);
    setError(undefined);
    if (storageKey === undefined) return;

    const pending = readIdempotentCreateAttempt(storageKey, isRequest);
    attemptRef.current = pending;
    if (pending === undefined) return;
    setPendingRequest(pending.request);
    setOutcomeUnknown(true);
    setError(unknownMessage);
  }, [isRequest, storageKey, unknownMessage]);

  function clearResolvedError(): void {
    if (!outcomeUnknown) setError(undefined);
  }

  async function submit(request: TRequest): Promise<void> {
    if (busyRef.current || storageKey === undefined) return;
    busyRef.current = true;
    const generation = contextRef.current.generation;
    const authEpoch = authEpochRef.current;
    const isCurrent = () => mountedRef.current && contextRef.current.generation === generation;

    const existingAttempt =
      attemptRef.current ?? readIdempotentCreateAttempt(storageKey, isRequest);
    attemptRef.current = existingAttempt;
    let authoritativeServerToday = serverToday;

    if (existingAttempt !== undefined) {
      setBusy(true);
      try {
        authoritativeServerToday = await readServerToday();
      } catch (requestError) {
        if (!isCurrent()) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          clearAuthenticatedClientState();
          onUnauthorized();
        } else {
          setError(unavailableMutationAuthorityMessage(actionLabel));
        }
        busyRef.current = false;
        setBusy(false);
        return;
      }
    }

    if (!isCurrent()) return;

    if (authoritativeServerToday === undefined) {
      setError(unavailableMutationAuthorityMessage(actionLabel));
      busyRef.current = false;
      setBusy(false);
      return;
    }

    const preparation = prepareServerDatedIdempotentCreateAttempt(
      storageKey,
      request,
      authoritativeServerToday,
      existingAttempt,
    );
    if (preparation.kind === "mismatch") {
      setError(changedMutationResultMessage());
      busyRef.current = false;
      setBusy(false);
      return;
    }
    if (preparation.kind === "expired") {
      setError(expiredMutationResultMessage(actionLabel));
      busyRef.current = false;
      setBusy(false);
      return;
    }
    if (preparation.kind === "storage-unavailable") {
      setError(unavailableMutationStorageMessage());
      busyRef.current = false;
      setBusy(false);
      return;
    }

    attemptRef.current = preparation.attempt;
    setBusy(true);
    setError(undefined);
    try {
      const result = await create(request, preparation.attempt.idempotencyKey);
      if (authEpochRef.current !== authEpoch) return;
      clearIdempotentCreateAttempt(storageKey, preparation.attempt.idempotencyKey);
      if (!isCurrent()) return;
      attemptRef.current = undefined;
      setPendingRequest(undefined);
      setOutcomeUnknown(false);
      busyRef.current = false;
      setBusy(false);
      onCreated(result.item.id);
    } catch (requestError) {
      const preAdmissionRejected =
        requestError instanceof ApiRequestError &&
        requestError.status === 503 &&
        ["MAINTENANCE_MODE", "SYSTEM_STATE_UNAVAILABLE"].includes(requestError.code);
      if (!isCurrent()) {
        if (authEpochRef.current !== authEpoch) return;
        if (
          !preparation.reused &&
          (preAdmissionRejected || !isMutationOutcomeUnknown(requestError))
        ) {
          clearIdempotentCreateAttempt(storageKey, preparation.attempt.idempotencyKey);
        }
        return;
      }
      if (preAdmissionRejected && preparation.reused) {
        setPendingRequest(preparation.attempt.request);
        setOutcomeUnknown(true);
        const retained = persistIdempotentCreateAttempt(storageKey, preparation.attempt);
        setError(
          `${requestError.message} 이번 요청은 저장 전에 차단됐어요. 이전 저장 결과는 아직 확인되지 않았어요. 점검 후 같은 요청으로 결과를 다시 확인해 주세요.${retained ? "" : " 이 화면을 닫거나 새로고침하지 마세요."}`,
        );
      } else if (!preAdmissionRejected && isMutationOutcomeUnknown(requestError)) {
        setPendingRequest(request);
        setOutcomeUnknown(true);
        setError(
          persistIdempotentCreateAttempt(storageKey, preparation.attempt)
            ? unknownMessage
            : `${unknownMessage} 이 화면을 닫거나 새로고침하지 마세요. 닫으면 저장됐는지 다시 확인할 수 없어요.`,
        );
      } else {
        clearIdempotentCreateAttempt(storageKey, preparation.attempt.idempotencyKey);
        attemptRef.current = undefined;
        setPendingRequest(undefined);
        setOutcomeUnknown(false);
        setError(
          requestError instanceof Error
            ? requestError.message
            : `${actionLabel}을 처리하지 못했습니다.`,
        );
      }
      busyRef.current = false;
      setBusy(false);
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        clearAuthenticatedClientState();
        onUnauthorized();
      }
    }
  }

  return {
    busy,
    clearResolvedError,
    error,
    outcomeUnknown,
    pendingRequest,
    submit,
  };
}
