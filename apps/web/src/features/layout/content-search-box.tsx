import { Search, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/*
 * 공지·준비물 목록 위에 놓는 검색창.
 *
 * 글자를 칠 때마다 서버를 부르지 않는다 — 한 글자마다 요청이 나가면 느린 회선에서
 * 결과가 뒤죽박죽 도착한다. 잠깐 멈췄을 때 한 번만 부른다.
 *
 * "찾은 게 없어요"와 "아직 아무것도 없어요"는 다른 상태라, 이 상자는 검색어만
 * 넘기고 그 구분은 목록 화면이 한다.
 */
export function ContentSearchBox({
  label,
  onSearch,
  placeholder,
  searchTerm,
}: {
  label: string;
  onSearch: (term: string | undefined) => void;
  placeholder: string;
  searchTerm?: string | undefined;
}): React.JSX.Element {
  const [value, setValue] = useState(searchTerm ?? "");
  /*
   * 부모가 렌더마다 새 함수를 넘겨도 타이머가 다시 걸리면 안 된다. 최신 함수를
   * 상자에 담아 두고 타이머는 입력값에만 반응하게 한다.
   */
  const latest = useRef(onSearch);
  latest.current = onSearch;
  /*
   * 화면을 열자마자 빈 검색어로 목록을 다시 부르지 않는다. 방금 받아 온 목록을
   * 곧바로 한 번 더 받는 셈이라 느린 회선에서 화면이 두 번 깜빡인다.
   * 값이 실제로 달라졌을 때만 알린다.
   */
  const emitted = useRef<string | undefined>(searchTerm);

  // 그려지는 순간 맞춘다. useEffect는 그린 뒤에 돌아 그 사이 친 검색어를 지워 버렸다(10-21 부하 재현 — 일정 11/480).
  useLayoutEffect(() => {
    emitted.current = searchTerm;
    setValue(searchTerm ?? "");
  }, [searchTerm]);

  useEffect(() => {
    const trimmed = value.trim();
    const next = trimmed.length === 0 ? undefined : trimmed;
    if (next === emitted.current) return;
    const timer = setTimeout(() => {
      emitted.current = next;
      latest.current(next);
    }, 300);
    return () => clearTimeout(timer);
  }, [value]);

  return (
    <div className="mb-4">
      <label className="block">
        <span className="sr-only">{label}</span>
        <span className="relative flex items-center">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-4 size-5 text-app-muted"
          />
          <input
            className="min-h-14 w-full rounded-2xl border border-app-border bg-app-surface pl-12 pr-12 text-base font-semibold text-app-text placeholder:text-app-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-role-primary"
            data-content-search
            maxLength={50}
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder}
            type="search"
            value={value}
          />
          {value.length === 0 ? null : (
            <button
              aria-label="검색어 지우기"
              className="ui-icon-button absolute right-2"
              onClick={() => setValue("")}
              type="button"
            >
              <X aria-hidden="true" size={18} />
            </button>
          )}
        </span>
      </label>
    </div>
  );
}
