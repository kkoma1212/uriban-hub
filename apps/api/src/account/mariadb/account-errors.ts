import { types } from "node:util";
import { withSerializationRetry, type DB, type DatabaseErrorClassifier } from "@classhub/db";
import { InternalServerErrorException } from "@nestjs/common";
import type { Kysely, Transaction } from "kysely";
import { NewPasswordRejectedException, UnauthenticatedException } from "../../auth/auth.errors.js";
import {
  RateLimitedException,
  RateLimitServiceUnavailableException,
} from "../../common/rate-limit/rate-limit.errors.js";
import { ERROR_CODES } from "../../common/errors/error-codes.js";
import {
  AccountDeletionBlockedByClassException,
  AccountProfileBlockedException,
  InvalidAccountDisplayNameException,
  InvalidAccountDeletionConfirmationException,
  InvalidCurrentPasswordException,
} from "../account.errors.js";

function metadata(error: unknown) {
  if (typeof error !== "object" || error === null || types.isProxy(error)) return undefined;
  return {
    errno: Object.getOwnPropertyDescriptor(error, "errno")?.value as unknown,
    state: Object.getOwnPropertyDescriptor(error, "sqlState")?.value as unknown,
  };
}

export function accountInternalError(): InternalServerErrorException {
  return new InternalServerErrorException({
    code: ERROR_CODES.INTERNAL_ERROR,
    message: "계정 변경 결과를 확인할 수 없습니다. 계정 상태를 확인해 주세요.",
  });
}

export function mapMariaDbAccountError(error: unknown, deleting = false): unknown {
  if (typeof error === "object" && error !== null && types.isProxy(error))
    return accountInternalError();
  if (
    error instanceof UnauthenticatedException ||
    error instanceof NewPasswordRejectedException ||
    error instanceof RateLimitedException ||
    error instanceof AccountDeletionBlockedByClassException ||
    error instanceof AccountProfileBlockedException ||
    error instanceof InvalidAccountDisplayNameException ||
    error instanceof InvalidAccountDeletionConfirmationException ||
    error instanceof InvalidCurrentPasswordException
  )
    return error;
  // Do not retain a Redis causal chain in the returned exception.
  if (error instanceof RateLimitServiceUnavailableException)
    return new RateLimitServiceUnavailableException();
  const native = metadata(error);
  if (deleting && native?.state === "45000") {
    if (native.errno === 30408 || native.errno === 30414) return new UnauthenticatedException();
    if (native.errno === 30411) return new AccountDeletionBlockedByClassException();
  }
  return accountInternalError();
}

const retryClassifier: DatabaseErrorClassifier = {
  classify(error) {
    const native = metadata(error);
    return native?.errno === 1213 && native.state === "40001"
      ? { kind: "deadlock", vendorCode: "1213" }
      : { kind: "unknown" };
  },
};

/** Retry only a body deadlock propagated after successful full rollback/release. */
export function executeAccountDeletion<T>(
  database: Kysely<DB>,
  mariaDb: boolean,
  operation: (tx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return withSerializationRetry(
    async () => {
      let bodyError: unknown;
      try {
        return await database.transaction().execute(async (tx) => {
          try {
            return await operation(tx);
          } catch (error) {
            bodyError = error;
            throw error;
          }
        });
      } catch (error) {
        if (mariaDb && (bodyError === undefined || error !== bodyError))
          throw accountInternalError();
        throw error;
      }
    },
    mariaDb ? { errorClassifier: retryClassifier } : {},
  );
}
