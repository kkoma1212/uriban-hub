/** 가입 입력칸 아래 오류 문구(입력칸 단계 공통). */
export function SignUpFieldError({
  id,
  message,
}: {
  id: string;
  message: string | undefined;
}): React.JSX.Element | null {
  if (message === undefined) return null;
  return (
    <p className="mt-2 text-sm font-medium text-rose-600" id={id} role="alert">
      {message}
    </p>
  );
}
