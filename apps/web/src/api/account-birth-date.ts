import { apiFetch, parseResponse, withCsrfRecovery } from "./auth";

/** 설정의 생년월일. available=false면 서버가 생년월일을 받지 않는 환경이다. */
export interface AccountBirthDate {
  available: boolean;
  birth_date: string | null;
  birthday_shared: boolean;
}

export async function getAccountBirthDate(signal?: AbortSignal): Promise<AccountBirthDate> {
  return parseResponse<AccountBirthDate>(
    await apiFetch("/api/v1/account/birth-date", {
      credentials: "include",
      signal: signal ?? null,
    }),
  );
}

export async function updateAccountBirthDate(request: {
  birth_date?: string;
  birthday_shared?: boolean;
}): Promise<AccountBirthDate> {
  const body = JSON.stringify(request);
  return withCsrfRecovery<AccountBirthDate>(({ apiFetch: send, csrfToken }) =>
    send("/api/v1/account/birth-date", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body,
    }),
  );
}
