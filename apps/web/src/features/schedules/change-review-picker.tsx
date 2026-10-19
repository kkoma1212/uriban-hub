import { Plus, Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { listUpdates, type UpdateItem } from "../../api/updates";

interface Props {
  selected: string[];
  disabled: boolean;
  onAdd: (kind: "notice" | "supply", id: string) => void;
}
export function ChangeReviewPicker({ selected, disabled, onAdd }: Props): React.JSX.Element {
  const [term, setTerm] = useState(""),
    [searched, setSearched] = useState("");
  const [items, setItems] = useState<UpdateItem[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState<string>();
  const id = useId(),
    request = useRef(0);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );
  async function search(more = false): Promise<void> {
    const token = ++request.current,
      query = more ? searched : term.trim();
    setLoading(true);
    setError(undefined);
    try {
      const result = await listUpdates(
        "all",
        more ? (cursor ?? undefined) : undefined,
        query === "" ? undefined : query,
      );
      if (request.current !== token) return;
      setSearched(query);
      setItems((current) =>
        more
          ? [
              ...current,
              ...result.items.filter(
                (item) =>
                  !current.some(
                    (previous) => previous.kind === item.kind && previous.id === item.id,
                  ),
              ),
            ]
          : result.items,
      );
      setCursor(result.next_cursor);
    } catch (failure) {
      if (request.current === token)
        setError(failure instanceof Error ? failure.message : "안내를 찾지 못했어요.");
    } finally {
      if (request.current === token) setLoading(false);
    }
  }
  return (
    <section
      aria-label="관련 안내 찾기"
      className="min-w-0 rounded-card border border-app-border bg-app-surface-raised p-5 sm:p-6"
    >
      <h2 className="text-lg font-extrabold text-app-text">관련 안내 연결</h2>
      <p className="mt-2 break-keep text-sm leading-6 text-app-muted">
        이번 검토에 연결할 기존 공지·준비물·숙제를 찾아 추가해 주세요. 최대 8개까지 함께 검토할 수
        있어요.
      </p>
      <form
        className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <div className="min-w-0">
          <label className="auth-label" htmlFor={id}>
            안내 검색
          </label>
          <input
            className="ui-input mt-2"
            disabled={disabled}
            id={id}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="제목·본문 검색"
            type="search"
            value={term}
          />
        </div>
        <button
          className="ui-button ui-button-secondary min-h-12 self-end"
          disabled={disabled || loading}
          type="submit"
        >
          <Search aria-hidden="true" size={17} />
          {loading ? "찾는 중" : "안내 찾기"}
        </button>
      </form>
      {error === undefined ? null : (
        <p className="mt-3 text-sm font-bold text-rose-700" role="alert">
          {error}
        </p>
      )}
      <ul className="mt-4 grid gap-2">
        {items.map((item) => {
          const added = selected.includes(`${item.kind}:${item.id}`);
          return (
            <li
              className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-app-border p-3"
              key={`${item.kind}:${item.id}`}
            >
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-role-primary">
                  {item.kind === "notice"
                    ? "공지"
                    : item.category === "homework"
                      ? "숙제"
                      : "준비물"}
                  {item.needed_on === null ? "" : ` · ${item.needed_on}`}
                </p>
                <p className="mt-1 break-words font-bold text-app-text">{item.title}</p>
              </div>
              <button
                aria-label={`${item.title} ${added ? "연결됨" : "검토에 추가"}`}
                className="ui-button ui-button-secondary min-h-11 text-sm"
                disabled={disabled || added || selected.length >= 9}
                onClick={() => onAdd(item.kind, item.id)}
                type="button"
              >
                <Plus aria-hidden="true" size={16} />
                {added ? "연결됨" : "추가"}
              </button>
            </li>
          );
        })}
      </ul>
      {cursor === null ? null : (
        <button
          className="ui-button ui-button-secondary mt-3 min-h-11 text-sm"
          disabled={disabled || loading}
          onClick={() => void search(true)}
          type="button"
        >
          안내 더 보기
        </button>
      )}
    </section>
  );
}
