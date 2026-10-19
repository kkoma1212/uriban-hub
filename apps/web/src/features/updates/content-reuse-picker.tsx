import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { ApiRequestError } from "../../api/auth";
import { listNotices } from "../../api/notices";
import { listSupplies } from "../../api/supplies";
import { ContentInputReview } from "../layout/content-input-frame";

type ReuseKind = "notice" | "homework";
interface ReuseChoice {
  id: string;
  title: string;
  label: string;
}
interface ContentReusePickerProps {
  open: boolean;
  initialKind: ReuseKind;
  onClose: () => void;
  onPick: (kind: ReuseKind, id: string) => void;
}

/** Reuses the existing notice/homework draft route; it never publishes the old post. */
export function ContentReusePicker({
  open,
  initialKind,
  onClose,
  onPick,
}: ContentReusePickerProps): React.JSX.Element {
  const navigate = useNavigate();
  const [kind, setKind] = useState(initialKind);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<ReuseChoice[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const load = useCallback(
    async (nextCursor?: string): Promise<void> => {
      const current = ++generation.current;
      setBusy(true);
      setError(false);
      try {
        const response =
          kind === "notice"
            ? await listNotices("all", nextCursor, search || undefined)
            : await listSupplies("past", nextCursor, "homework", search || undefined);
        if (current !== generation.current) return;
        const next = response.items.map((item) => ({
          id: item.id,
          title: item.title,
          label: "published_at" in item ? item.published_at.slice(0, 10) : item.needed_on,
        }));
        setItems((previous) => (nextCursor === undefined ? next : [...previous, ...next]));
        setCursor(response.next_cursor);
      } catch (failure) {
        if (current !== generation.current) return;
        if (failure instanceof ApiRequestError && failure.status === 401)
          void navigate("/login", { replace: true });
        else setError(true);
      } finally {
        if (current === generation.current) setBusy(false);
      }
    },
    [kind, navigate, search],
  );
  useEffect(() => {
    if (open) {
      setKind(initialKind);
      setQuery("");
      setSearch("");
      setSelected(undefined);
    }
  }, [initialKind, open]);
  useEffect(() => {
    if (!open) return;
    setSelected(undefined);
    setItems([]);
    setCursor(null);
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load, open]);
  return (
    <ContentInputReview
      open={open}
      title="지난 글 불러오기"
      cancelLabel="닫기"
      confirmLabel="선택한 글 불러오기"
      confirmDisabled={selected === undefined || busy}
      onCancel={onClose}
      onConfirm={() => {
        if (selected !== undefined) onPick(kind, selected);
      }}
    >
      <p className="mb-3 text-sm leading-6 text-app-muted">
        공지와 숙제를 새 초안으로 가져옵니다. 기존 글과 현재 작성 중인 초안은 그대로 보관돼요. 받는
        사람과 날짜는 다시 확인해 주세요.
      </p>
      <div aria-label="불러올 글 종류" className="mb-3 flex gap-2" role="group">
        {(["notice", "homework"] as const).map((value) => (
          <button
            aria-pressed={kind === value}
            className="content-filter"
            key={value}
            onClick={() => {
              setKind(value);
              setQuery("");
              setSearch("");
            }}
            type="button"
          >
            {value === "notice" ? "공지" : "숙제"}
          </button>
        ))}
      </div>
      <div className="mb-3 flex gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">지난 글 검색</span>
          <input
            className="ui-input"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                setSearch(query.trim());
              }
            }}
            placeholder="제목이나 내용 검색"
            value={query}
          />
        </label>
        <button
          className="ui-button ui-button-secondary"
          disabled={busy}
          onClick={() => setSearch(query.trim())}
          type="button"
        >
          검색
        </button>
      </div>
      {error ? (
        <div role="alert">
          <p className="text-sm text-danger-text">지난 글을 불러오지 못했어요.</p>
          <button
            className="ui-button ui-button-secondary mt-2"
            disabled={busy}
            onClick={() => void load()}
            type="button"
          >
            다시 시도
          </button>
        </div>
      ) : null}
      {busy && items.length === 0 ? (
        <p role="status">지난 글을 불러오고 있어요.</p>
      ) : items.length === 0 && !error ? (
        <p className="text-sm text-app-muted">
          불러올 {kind === "notice" ? "공지" : "지난 숙제"}가 없어요.
        </p>
      ) : (
        <fieldset className="grid gap-2">
          <legend className="sr-only">불러올 글</legend>
          {items.map((item) => (
            <label
              className="flex gap-3 rounded-xl border border-app-border bg-app-surface-raised p-3"
              key={item.id}
            >
              <input
                checked={selected === item.id}
                className="mt-1"
                name="reuse-source"
                onChange={() => setSelected(item.id)}
                type="radio"
              />
              <span className="min-w-0">
                <strong className="block break-words text-sm">{item.title}</strong>
                <span className="text-xs text-app-muted">{item.label}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {cursor === null ? null : (
        <button
          className="ui-button ui-button-secondary mt-3 w-full"
          disabled={busy}
          onClick={() => void load(cursor)}
          type="button"
        >
          지난 글 더 보기
        </button>
      )}
    </ContentInputReview>
  );
}
