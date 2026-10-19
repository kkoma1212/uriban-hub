import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import {
  getAccountBirthDate,
  updateAccountBirthDate,
  type AccountBirthDate,
} from "../../api/account-birth-date";
import {
  EARLIEST_BIRTH_DATE,
  formatBirthMonthDay,
  isAcceptableBirthDate,
  koreanFullAge,
  kstToday,
} from "../../lib/birth-date";

/**
 * 설정의 생년월일(2026-10-01 사용자 결정). 비어 있는 계정은 한 번 입력하고,
 * 생일 당일 우리 반 홈에 이름을 알릴지는 본인이 켠다. 서버가 받지 않는 환경이면 보이지 않는다.
 */
export function BirthDatePanel({
  role = "student",
}: {
  role?: "student" | "teacher";
}): React.JSX.Element | null {
  const [data, setData] = useState<AccountBirthDate>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  // 저장하면 직접 고칠 수 없으므로 한 번 더 확인한다(총검수 B3-12).
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void getAccountBirthDate(controller.signal)
      .then(setData)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  if (!data?.available) return null;

  async function save(request: { birth_date?: string; birthday_shared?: boolean }, done: string) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setData(await updateAccountBirthDate(request));
      setNotice(done);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "생년월일을 저장하지 못했어요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="birth-date-title" className="surface-panel mt-6 p-5 sm:p-6">
      <h2 className="text-lg font-bold text-app-text" id="birth-date-title">
        생년월일
      </h2>
      {data.birth_date === null ? (
        <form
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!isAcceptableBirthDate(draft)) {
              setError("생년월일을 확인해 주세요.");
              return;
            }
            if (!confirming) {
              setError(undefined);
              setConfirming(true);
              return;
            }
            void save({ birth_date: draft }, "생년월일을 저장했어요.");
          }}
        >
          <p className="text-sm leading-6 text-app-muted" id="birth-date-help">
            한 번 입력하면 직접 고칠 수 없어요.
            {role === "student"
              ? " 담임 선생님이 학생 확인에 써요."
              : " 수정하려면 운영자에게 문의해 주세요."}
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="sr-only" htmlFor="account-birth-date">
              생년월일
            </label>
            <input
              aria-describedby="birth-date-help"
              className="auth-input max-w-56"
              disabled={busy}
              id="account-birth-date"
              max={kstToday()}
              min={EARLIEST_BIRTH_DATE}
              onChange={(event) => {
                setDraft(event.target.value);
                setConfirming(false);
              }}
              type="date"
              value={draft}
            />
            <button
              aria-busy={busy}
              className="ui-button ui-button-primary min-h-11 px-4"
              disabled={busy || draft === ""}
              type="submit"
            >
              {busy && <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />}
              {confirming ? "맞아요, 저장" : "저장"}
            </button>
            {confirming && (
              <button
                className="ui-button ui-button-secondary min-h-11 px-4"
                disabled={busy}
                onClick={() => setConfirming(false)}
                type="button"
              >
                다시 고르기
              </button>
            )}
          </div>
          {confirming && isAcceptableBirthDate(draft) && (
            <p className="mt-2 break-keep text-sm font-semibold text-app-text" role="status">
              {Number(draft.slice(0, 4))}년 {Number(draft.slice(5, 7))}월{" "}
              {Number(draft.slice(8, 10))}일(만 {koreanFullAge(draft)}세)이 맞나요? 저장하면 직접
              고칠 수 없어요.
            </p>
          )}
        </form>
      ) : (
        <>
          <p className="mt-2 text-sm leading-6 text-app-text">
            {data.birth_date.replaceAll("-", ". ")}.
            <span className="ml-1 text-app-muted">고치려면 운영자에게 문의해 주세요.</span>
          </p>
          {role === "student" ? (
            <>
              <label className="mt-4 flex min-h-11 cursor-pointer items-center gap-3 text-sm font-semibold text-app-text">
                <input
                  checked={data.birthday_shared}
                  className="auth-checkbox"
                  disabled={busy}
                  onChange={(event) =>
                    void save(
                      { birthday_shared: event.target.checked },
                      event.target.checked
                        ? `${formatBirthMonthDay(data.birth_date!)}에 우리 반 홈에 생일을 알려요.`
                        : "생일 알림을 껐어요.",
                    )
                  }
                  type="checkbox"
                />
                생일에 우리 반 홈에 알리기
              </label>
              <p className="text-xs leading-5 text-app-muted">
                켜면 생일 당일 반 친구와 선생님 홈에 이름만 보여요. 태어난 해는 보이지 않아요.
              </p>
            </>
          ) : null}
        </>
      )}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger-text">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-3 text-sm text-success-text">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
