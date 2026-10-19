interface SchoolDetails {
  school_address?: string | null;
  school_homepage_url?: string | null;
  school_name: string;
  school_phone_number?: string | null;
}

type DetailItems = readonly (readonly [string, React.ReactNode])[];

function telephoneHref(phoneNumber: string): string {
  return `tel:${phoneNumber.replace(/\D/gu, "")}`;
}

export function DetailsGrid({
  details,
  tile = false,
}: {
  details: DetailItems;
  tile?: boolean;
}): React.JSX.Element {
  return (
    <dl className={tile ? "mt-6 grid gap-3 sm:grid-cols-3" : "mt-5 grid gap-4 sm:grid-cols-2"}>
      {details.map(([label, value], index) => (
        <div
          className={
            tile
              ? "rounded-2xl bg-app-surface-muted px-4 py-4"
              : index === 0
                ? "sm:col-span-2"
                : undefined
          }
          key={label}
        >
          <dt className="text-xs font-bold text-app-muted">{label}</dt>
          <dd className="mt-1 break-keep font-black leading-6 text-app-text">
            {value ?? <span className="text-app-muted">제공된 정보가 없어요.</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function SchoolDetailsPanel({ school }: { school: SchoolDetails }): React.JSX.Element {
  const phoneHref = school.school_phone_number ? telephoneHref(school.school_phone_number) : null;
  const details = [
    ["주소", school.school_address],
    [
      "전화번호",
      phoneHref === null ? null : (
        <a
          aria-label={`${school.school_name} ${school.school_phone_number} 전화 앱 열기`}
          className="ui-button ui-button-secondary text-sm"
          href={phoneHref}
        >
          {school.school_phone_number}
        </a>
      ),
    ],
    [
      "홈페이지",
      school.school_homepage_url ? (
        <a
          className="ui-button ui-button-secondary text-sm"
          href={school.school_homepage_url}
          rel="noreferrer"
          target="_blank"
        >
          학교 홈페이지 열기
        </a>
      ) : null,
    ],
  ] as const;

  return (
    <div className="mt-5 rounded-2xl border border-app-border bg-app-surface-muted p-5">
      <p className="text-xs font-bold text-role-primary">우리 학교 · 교육청(나이스) 정보</p>
      <h2 className="mt-1 text-lg font-black text-app-text">{school.school_name}</h2>
      <DetailsGrid details={details} />
    </div>
  );
}
