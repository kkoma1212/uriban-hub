/*
 * 학급 범위 쓰기 경로들이 `classes`와 `users`를 서로 반대 순서로 잠근다.
 * 자리배치·모둠배치 생성은 classes를 먼저 잡고 명부의 users를 나중에 잡는 반면,
 * 반나가기·계정삭제는 자기 users를 먼저 잡고 classes를 나중에 잡는다. 두 요청이
 * 겹치면 PostgreSQL이 사이클을 탐지해 한쪽을 40P01로 중단시키고, 매핑이 없어
 * 500으로 노출된다(2026-08-01 감사 P1-02).
 *
 * 잠금 순서 자체를 통일하는 것이 근본 해결이고 그건 별도 작업이다. 이 계층은 그
 * 전까지의 그물이자, 순서를 고친 뒤에도 남을 직렬화 실패(40001)에 대한 대비다.
 *
 * 재시도가 안전한 이유: 40P01·40001로 중단된 트랜잭션은 이미 전부 롤백됐다.
 * 부분 적용이 남지 않으므로 같은 작업을 다시 실행하면 된다. 다만 트랜잭션 밖의
 * 부수효과(메일 발송 등)까지 함께 감싸면 그것이 두 번 일어나므로, 이 함수는
 * 반드시 DB 트랜잭션 하나만 감싸야 한다.
 */

import {
  postgresDatabaseErrorClassifier,
  type DatabaseErrorClassifier,
  type DatabaseErrorKind,
} from "./database-error-classifier.js";

const RETRYABLE_ERROR_KINDS = new Set<DatabaseErrorKind>(["deadlock", "serialization_failure"]);

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 20;

export interface SerializationRetryOptions {
  baseDelayMs?: number;
  /** Defaults to the current PostgreSQL production adapter. */
  errorClassifier?: DatabaseErrorClassifier;
  maxAttempts?: number;
  /** 재시도할 때마다 호출된다. 관측용이며 던지지 않아야 한다. */
  onRetry?: (attempt: number, code: string) => void;
  /** 테스트에서 대기를 건너뛰기 위한 주입점. */
  sleep?: (milliseconds: number) => Promise<void>;
}

export function isRetryableSerializationError(
  error: unknown,
  classifier: DatabaseErrorClassifier = postgresDatabaseErrorClassifier,
): boolean {
  return RETRYABLE_ERROR_KINDS.has(classifier.classify(error).kind);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function withSerializationRetry<T>(
  operation: () => Promise<T>,
  options: SerializationRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const errorClassifier = options.errorClassifier ?? postgresDatabaseErrorClassifier;
  const sleep = options.sleep ?? defaultSleep;

  let attempt = 1;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      // 마지막 시도였거나 재시도 대상이 아니면 원래 오류를 그대로 올린다 —
      // 여기서 다른 오류로 감싸면 상위의 도메인 예외 처리가 망가진다.
      const classified = errorClassifier.classify(error);
      if (attempt >= maxAttempts || !RETRYABLE_ERROR_KINDS.has(classified.kind)) throw error;
      const code = classified.vendorCode ?? classified.kind;
      options.onRetry?.(attempt, code);
      // 두 요청이 같은 간격으로 재시도하면 다시 부딪힌다. 지수 증가에 지터를 얹는다.
      const backoffMs = baseDelayMs * 2 ** (attempt - 1);
      await sleep(backoffMs + Math.random() * baseDelayMs);
      attempt += 1;
    }
  }
}
