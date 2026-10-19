import { GraduationCap, Presentation } from "lucide-react";
import {
  EARLIEST_BIRTH_DATE,
  isAcceptableBirthDate,
  koreanFullAge,
  kstToday,
} from "../../lib/birth-date";

/*
 * 2026-09-27 확정 시안(로그인가입_v3_확정): 가입의 '누구로'와 '나이'를 큰 카드 · 두 칸으로.
 * 라디오는 화면에서 숨기되(sr-only) 그대로 두어 키보드 · 화면 읽기 프로그램 동작을 지킨다.
 */

type Role = "student" | "teacher";
type AgeRoute = "guardian_consent" | "over_14";

const ROLES = [
  {
    description: "선생님 초대 코드로 반에 참여해요.",
    icon: GraduationCap,
    label: "학생",
    value: "student",
  },
  {
    description: "관리자 승인 후 반을 만들고 학생을 초대해요.",
    icon: Presentation,
    label: "선생님",
    value: "teacher",
  },
] as const;

const CARD =
  "flex cursor-pointer rounded-2xl border border-app-border bg-app-surface-raised text-app-text transition-colors hover:border-role-primary has-[:checked]:border-2 has-[:checked]:border-role-primary has-[:checked]:bg-role-soft has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-role-primary has-[:focus-visible]:ring-offset-2";

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <p className="mt-2 text-sm font-medium text-danger-text" id={id} role="alert">
      {message}
    </p>
  );
}

export function RoleChoice({
  error,
  onSelect,
  selected,
}: {
  error: string | undefined;
  onSelect: (role: Role) => void;
  selected: Role | undefined;
}): React.JSX.Element {
  return (
    <fieldset
      aria-describedby={error === undefined ? undefined : "sign-up-role-error"}
      aria-invalid={error === undefined ? undefined : true}
      className="min-w-0"
    >
      <legend className="mb-2.5 text-base font-extrabold text-app-text">누구로 가입할까요?</legend>
      <div className="grid grid-cols-2 gap-2.5">
        {ROLES.map(({ description, icon: Icon, label, value }) => (
          <label
            className={`${CARD} min-h-36 flex-col items-center justify-start gap-2 px-3 py-4 text-center`}
            data-sign-up-role={value}
            key={value}
          >
            <input
              aria-describedby={`sign-up-role-${value}-description`}
              aria-label={label}
              aria-required="true"
              checked={selected === value}
              className="peer sr-only"
              name="role"
              onChange={() => onSelect(value)}
              required
              type="radio"
              value={value}
            />
            <span className="grid size-12 place-items-center rounded-full bg-role-soft text-role-primary peer-checked:bg-role-primary peer-checked:text-white">
              <Icon aria-hidden="true" size={24} />
            </span>
            <span className="text-lg font-extrabold">{label}</span>
            <span
              className="break-keep text-xs leading-5 text-app-muted"
              id={`sign-up-role-${value}-description`}
            >
              {description}
            </span>
          </label>
        ))}
      </div>
      <FieldError id="sign-up-role-error" message={error} />
    </fieldset>
  );
}

export function AgeRouteChoice({
  birthDateOffered = false,
  error,
  onSelect,
  selected,
}: {
  /** 아래에 생년월일(선택) 칸이 함께 있으면 '수집하지 않아요' 문장을 빼야 한다. */
  birthDateOffered?: boolean;
  error: string | undefined;
  onSelect: (route: AgeRoute) => void;
  selected: AgeRoute | undefined;
}): React.JSX.Element {
  return (
    <fieldset
      aria-describedby={error === undefined ? undefined : "sign-up-age-route-error"}
      aria-invalid={error === undefined ? undefined : true}
      className="min-w-0"
    >
      <legend className="text-base font-extrabold text-app-text">나이를 골라 주세요</legend>
      <p className="mb-2.5 mt-1 break-keep text-xs leading-5 text-app-muted">
        {birthDateOffered
          ? "만 14세 미만은 보호자 동의가 필요해요."
          : "생년월일은 수집하지 않아요. 만 14세 미만은 보호자 동의가 필요해요."}
      </p>
      <div className="grid grid-cols-2 gap-2.5">
        {(
          [
            ["over_14", "만 14세 이상입니다"],
            ["guardian_consent", "만 14세 미만이며 보호자 동의로 가입합니다"],
          ] as const
        ).map(([value, label]) => (
          <label
            className={`${CARD} min-h-14 items-center justify-center px-3 py-2 text-center text-sm font-extrabold`}
            key={value}
          >
            <input
              aria-required="true"
              checked={selected === value}
              className="sr-only"
              name="age_route"
              onChange={() => onSelect(value)}
              required
              type="radio"
              value={value}
            />
            {/* 화면에는 짧게, 화면 읽기 프로그램에는 기존 문장 그대로. */}
            <span aria-hidden="true">{value === "over_14" ? "만 14세 이상" : "만 14세 미만"}</span>
            <span className="sr-only">{label}</span>
          </label>
        ))}
      </div>
      <FieldError id="sign-up-age-route-error" message={error} />
    </fieldset>
  );
}

/** 생년월일을 받는 환경의 나이 확인. 만 나이를 보여 주고 14세 미만이면 보호자 동의로 안내한다. */
export function BirthDateField({
  error,
  inputProps,
  optional = false,
  role,
  value,
}: {
  error: string | undefined;
  inputProps: React.InputHTMLAttributes<HTMLInputElement>;
  /** 2026-10-02 사용자 결정(P-025③): 생년월일은 선택 입력. */
  optional?: boolean;
  role?: Role | undefined;
  value: string;
}): React.JSX.Element {
  const teacher = role === "teacher";
  const valid = isAcceptableBirthDate(value);
  const age = valid ? koreanFullAge(value) : null;
  // 미래·너무 이른 날짜는 '다음'만 꺼지고 이유가 안 보였다(총검수 B3-03).
  const shownError =
    error ?? (value !== "" && !valid ? "오늘까지의 실제 생년월일을 입력해 주세요." : undefined);
  return (
    <div className="min-w-0">
      <label className="text-base font-extrabold text-app-text" htmlFor="sign-up-birth-date">
        {optional ? "생년월일 (선택)" : "생년월일을 입력해 주세요"}
      </label>
      <p
        className="mb-2.5 mt-1 break-keep text-xs leading-5 text-app-muted"
        id="sign-up-birth-date-help"
      >
        {teacher
          ? optional
            ? "비워 둬도 가입할 수 있어요. 입력하면 만 14세 여부를 자동으로 확인해요."
            : "입력한 생년월일로 만 14세 여부를 확인해요. 만 14세 미만은 보호자 동의가 필요해요."
          : optional
            ? "비워 둬도 가입할 수 있어요. 입력하면 만 14세 여부를 자동으로 확인하고, 담임 선생님의 학생 확인과 생일 알림(설정에서 켤 때)에 쓰여요."
            : "만 14세 미만은 보호자 동의가 필요해요. 담임 선생님이 학생 확인에 쓰고, 생일 알림은 설정에서 직접 켤 때만 보여요."}
      </p>
      <input
        aria-describedby={[
          "sign-up-birth-date-help",
          age === null ? null : "sign-up-birth-date-age",
          shownError === undefined ? null : "sign-up-birth-date-error",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-invalid={shownError === undefined ? undefined : true}
        aria-required={optional ? undefined : "true"}
        className="auth-input"
        id="sign-up-birth-date"
        max={kstToday()}
        min={EARLIEST_BIRTH_DATE}
        type="date"
        {...inputProps}
      />
      {age !== null && (
        <p
          className="mt-2 break-keep text-sm font-semibold text-app-text"
          id="sign-up-birth-date-age"
          role="status"
        >
          만 {age}세예요.{age < 14 ? " 보호자 동의 후 가입할 수 있어요." : ""}
        </p>
      )}
      <FieldError id="sign-up-birth-date-error" message={shownError} />
    </div>
  );
}
