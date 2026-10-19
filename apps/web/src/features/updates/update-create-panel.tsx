import { Backpack, BellRing, ClipboardCheck, NotebookPen, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { createPortal } from "react-dom";

import { isContentAudienceRequest } from "../../api/content-audiences";
import { createNotice, listNotices, type NoticeWriteRequest } from "../../api/notices";
import {
  createSupply,
  listSupplies,
  type SupplyCategory,
  type SupplyWriteRequest,
} from "../../api/supplies";
import { useIdempotentContentCreate } from "../../lib/use-idempotent-content-create";
import { ContentReusePicker } from "./content-reuse-picker";
import { NoticeForm } from "../notices/notice-form";
import { NOTICE_CREATED_MESSAGE } from "../notices/notice-format";
import { categoryCreatedNotice } from "../supplies/supply-format";
import { SupplyForm } from "../supplies/supply-form";
import { useModalIsolation } from "../layout/use-modal-isolation";
import { useContentDesktop } from "./content-list-view";

export type UpdateCreateKind = "notice" | "supply" | "homework";

interface UpdateCreatePanelProps {
  initialKind?: UpdateCreateKind | undefined;
  membershipId: string;
  onClose: () => void;
  selectedAudienceEnabled: boolean;
  serverToday: string | undefined;
}

const EMPTY_NOTICE: NoticeWriteRequest = {
  audience: { mode: "all" },
  category: "general",
  content: "",
  is_important: false,
  title: "",
};

const EMPTY_SUPPLY: SupplyWriteRequest = {
  audience: { mode: "all" },
  category: "general",
  description: null,
  needed_on: "",
  title: "",
};

const UPDATE_CREATE_DRAFT_VERSION = "v1";

function updateCreateDraftStorageKey(kind: UpdateCreateKind, membershipId: string): string {
  return `classhub:update-create:${UPDATE_CREATE_DRAFT_VERSION}:${membershipId}:${kind}`;
}

function updateCreateKindStorageKey(membershipId: string): string {
  return `classhub:update-create:${UPDATE_CREATE_DRAFT_VERSION}:${membershipId}:kind`;
}

function readStoredDraft<TRequest>(
  storageKey: string,
  isRequest: (value: unknown) => value is TRequest,
): TRequest | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const stored = window.sessionStorage.getItem(storageKey);
    if (stored === null) return undefined;
    const parsed: unknown = JSON.parse(stored);
    if (isRequest(parsed)) return parsed;
    window.sessionStorage.removeItem(storageKey);
    return undefined;
  } catch {
    return undefined;
  }
}

function readStoredKind(storageKey: string): UpdateCreateKind | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const stored = window.sessionStorage.getItem(storageKey);
    if (stored === null) return undefined;
    const parsed: unknown = JSON.parse(stored);
    return parsed === "notice" || parsed === "supply" || parsed === "homework" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function persistStoredValue(storageKey: string, value: unknown): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function removeStoredValue(storageKey: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.sessionStorage.removeItem(storageKey);
    return true;
  } catch {
    return false;
  }
}

function isNoticeWriteRequest(value: unknown): value is NoticeWriteRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<NoticeWriteRequest>;
  return (
    (request.audience === undefined || isContentAudienceRequest(request.audience)) &&
    (request.category === undefined ||
      request.category === "general" ||
      request.category === "performance") &&
    typeof request.content === "string" &&
    typeof request.is_important === "boolean" &&
    typeof request.title === "string"
  );
}

function isSupplyWriteRequest(value: unknown): value is SupplyWriteRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<SupplyWriteRequest>;
  return (
    (request.audience === undefined || isContentAudienceRequest(request.audience)) &&
    (request.category === undefined ||
      request.category === "general" ||
      request.category === "homework") &&
    (request.description === null || typeof request.description === "string") &&
    typeof request.needed_on === "string" &&
    typeof request.title === "string"
  );
}

export function UpdateCreatePanel({
  initialKind,
  membershipId,
  onClose,
  selectedAudienceEnabled,
  serverToday,
}: UpdateCreatePanelProps): React.JSX.Element {
  const navigate = useNavigate();
  const desktop = useContentDesktop();
  const [presentationDesktop, setPresentationDesktop] = useState(desktop);
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    // Moving a portal remounts its children. Keep an open review/recipient dialog intact
    // and let its modal layer remain on top until it closes before changing presentation.
    const synchronize = () => {
      const nestedDialog = [
        ...document.querySelectorAll('[role="dialog"][aria-modal="true"]'),
      ].some((dialog) => dialog !== panelRef.current);
      if (!nestedDialog) setPresentationDesktop(desktop);
    };
    synchronize();
    const observer = new MutationObserver(synchronize);
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, [desktop]);
  const noticeDraftStorageKey = updateCreateDraftStorageKey("notice", membershipId);
  const supplyDraftStorageKey = updateCreateDraftStorageKey("supply", membershipId);
  const kindStorageKey = updateCreateKindStorageKey(membershipId);
  const [noticeDraft, setNoticeDraft] = useState<NoticeWriteRequest>(
    () => readStoredDraft(noticeDraftStorageKey, isNoticeWriteRequest) ?? EMPTY_NOTICE,
  );
  const [supplyDraft, setSupplyDraft] = useState<SupplyWriteRequest>(() => {
    const draft = readStoredDraft(supplyDraftStorageKey, isSupplyWriteRequest) ?? EMPTY_SUPPLY;
    return initialKind === "homework" || initialKind === "supply"
      ? { ...draft, category: initialKind === "homework" ? "homework" : "general" }
      : draft;
  });
  const [kind, setKind] = useState<UpdateCreateKind | undefined>(() => {
    const storedKind = readStoredKind(kindStorageKey);
    return (
      initialKind ??
      (storedKind === "supply" && supplyDraft.category === "homework" ? "homework" : storedKind) ??
      "notice"
    );
  });
  const [reuseOpen, setReuseOpen] = useState(false);
  const [draftSaveFailed, setDraftSaveFailed] = useState(false);
  const completedKindRef = useRef<UpdateCreateKind | undefined>(undefined);
  /* 등록을 마쳤다고 알릴 때 종류를 말하려면 방금 무엇을 보냈는지 알아야 한다(준비물 화면과 같다). */
  const submittedCategoryRef = useRef<SupplyCategory>("general");
  const noticeKindButtonRef = useRef<HTMLButtonElement>(null);

  const persistNoticeDraft = useCallback(
    (request: NoticeWriteRequest) => {
      if (completedKindRef.current === "notice") return;
      setNoticeDraft(request);
      setDraftSaveFailed(!persistStoredValue(noticeDraftStorageKey, request));
    },
    [noticeDraftStorageKey],
  );
  const persistSupplyDraft = useCallback(
    (request: SupplyWriteRequest) => {
      if (completedKindRef.current === "supply") return;
      setSupplyDraft(request);
      setDraftSaveFailed(!persistStoredValue(supplyDraftStorageKey, request));
    },
    [supplyDraftStorageKey],
  );

  function clearCompletedDraft(completedKind: UpdateCreateKind): void {
    completedKindRef.current = completedKind;
    const draftKey = completedKind === "notice" ? noticeDraftStorageKey : supplyDraftStorageKey;
    const draftCleared = removeStoredValue(draftKey);
    const kindCleared = removeStoredValue(kindStorageKey);
    setDraftSaveFailed(!draftCleared || !kindCleared);
  }

  const noticeCreate = useIdempotentContentCreate<NoticeWriteRequest>({
    actionLabel: "공지 등록 요청",
    create: createNotice,
    isRequest: isNoticeWriteRequest,
    membershipId,
    onCreated: (noticeId) => {
      clearCompletedDraft("notice");
      void navigate(`/notices/${noticeId}`, {
        state: { notice: NOTICE_CREATED_MESSAGE },
      });
    },
    onUnauthorized: () => void navigate("/login", { replace: true }),
    readServerToday: async () => (await listNotices("all")).server_today,
    resource: "notices",
    serverToday,
  });
  const supplyCreate = useIdempotentContentCreate<SupplyWriteRequest>({
    actionLabel: "준비물·숙제 등록 요청",
    create: createSupply,
    isRequest: isSupplyWriteRequest,
    membershipId,
    onCreated: (supplyId) => {
      clearCompletedDraft("supply");
      void navigate(`/supplies/${supplyId}`, {
        state: { notice: categoryCreatedNotice(submittedCategoryRef.current) },
      });
    },
    onUnauthorized: () => void navigate("/login", { replace: true }),
    readServerToday: async () => (await listSupplies("upcoming")).server_today,
    resource: "supplies",
    serverToday,
  });

  useEffect(() => {
    if (initialKind !== undefined && !noticeCreate.outcomeUnknown && !supplyCreate.outcomeUnknown) {
      setKind(initialKind);
      if (initialKind !== "notice") {
        setSupplyDraft((draft) => ({
          ...draft,
          category: initialKind === "homework" ? "homework" : "general",
        }));
      }
    }
  }, [initialKind, noticeCreate.outcomeUnknown, supplyCreate.outcomeUnknown]);

  useEffect(() => {
    if (noticeCreate.outcomeUnknown && !supplyCreate.outcomeUnknown) {
      setKind("notice");
    } else if (supplyCreate.outcomeUnknown && !noticeCreate.outcomeUnknown) {
      setKind(supplyCreate.pendingRequest?.category === "homework" ? "homework" : "supply");
    } else if (noticeCreate.outcomeUnknown && supplyCreate.outcomeUnknown && kind === undefined) {
      setKind("notice");
    }
  }, [
    kind,
    noticeCreate.outcomeUnknown,
    supplyCreate.outcomeUnknown,
    supplyCreate.pendingRequest?.category,
  ]);

  useEffect(() => {
    if (kind === undefined) return;
    setDraftSaveFailed(!persistStoredValue(kindStorageKey, kind));
  }, [kind, kindStorageKey]);

  useEffect(() => {
    if (kind === undefined) noticeKindButtonRef.current?.focus();
  }, [kind]);

  const activeCreate = kind === "notice" ? noticeCreate : supplyCreate;
  const busy = noticeCreate.busy || supplyCreate.busy;
  const kindSelectionLocked = busy || noticeCreate.outcomeUnknown || supplyCreate.outcomeUnknown;
  useModalIsolation({
    dialogRef: panelRef,
    initialFocusRef: closeButtonRef,
    onDismiss: () => {
      if (!busy) onClose();
    },
    open: !presentationDesktop,
  });

  function selectKind(
    nextKind: UpdateCreateKind,
    noticeCategory: "general" | "performance" = "general",
  ): void {
    noticeCreate.clearResolvedError();
    supplyCreate.clearResolvedError();
    if (nextKind === "notice") {
      persistNoticeDraft({ ...noticeDraft, category: noticeCategory });
    } else {
      persistSupplyDraft({
        ...supplyDraft,
        category: nextKind === "homework" ? "homework" : "general",
      });
    }
    setKind(nextKind);
  }

  const kinds = (
    <div aria-label="소식 종류" className="content-input-kinds" role="group">
      <button
        aria-pressed={
          kind === "notice" &&
          (noticeCreate.pendingRequest?.category ?? noticeDraft.category) !== "performance"
        }
        disabled={kindSelectionLocked}
        onClick={() => selectKind("notice", "general")}
        ref={noticeKindButtonRef}
        type="button"
      >
        <BellRing aria-hidden="true" size={21} />
        공지
      </button>
      <button
        aria-pressed={kind === "homework"}
        disabled={kindSelectionLocked}
        onClick={() => selectKind("homework")}
        type="button"
      >
        <ClipboardCheck aria-hidden="true" size={21} />
        숙제
      </button>
      <button
        aria-pressed={kind === "supply"}
        disabled={kindSelectionLocked}
        onClick={() => selectKind("supply")}
        type="button"
      >
        <Backpack aria-hidden="true" size={21} />
        준비물
      </button>
      <button
        aria-pressed={
          kind === "notice" &&
          (noticeCreate.pendingRequest?.category ?? noticeDraft.category) === "performance"
        }
        disabled={kindSelectionLocked}
        onClick={() => selectKind("notice", "performance")}
        type="button"
      >
        <NotebookPen aria-hidden="true" size={21} />
        수행평가
      </button>
    </div>
  );

  const panel = (
    <section
      aria-labelledby="update-create-title"
      aria-modal={presentationDesktop ? undefined : true}
      className="content-input-composer"
      data-app-role="teacher"
      id="update-create-panel"
      ref={panelRef}
      role={presentationDesktop ? undefined : "dialog"}
      tabIndex={presentationDesktop ? undefined : -1}
    >
      <div className="content-input-composer-header">
        <h1 id="update-create-title">소식 쓰기</h1>
        <button
          aria-label="소식 작성 닫기"
          className="ui-icon-button ui-button-secondary shrink-0"
          disabled={busy}
          onClick={onClose}
          ref={closeButtonRef}
          type="button"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </div>
      <p
        aria-live="polite"
        className="content-input-composer-status mb-2"
        data-save-failed={draftSaveFailed}
        data-update-draft-status
        role="status"
      >
        {draftSaveFailed
          ? "자동 저장을 사용할 수 없어요. 이 화면을 닫기 전에 내용을 복사해 주세요."
          : "작성 내용은 이 탭에 실시간 저장돼요. 종류를 바꾸거나 취소해도 유지됩니다."}
      </p>
      {activeCreate.error === undefined ? null : (
        <div className="content-input-error mb-2" role="alert">
          {activeCreate.error}
        </div>
      )}
      {kind === "notice" ? (
        <NoticeForm
          key={"notice-" + noticeDraft.category}
          busy={noticeCreate.busy}
          compositionHeader={kinds}
          focusTitleOnMount={!noticeCreate.outcomeUnknown}
          initialValue={noticeCreate.pendingRequest ?? noticeDraft}
          locked={noticeCreate.outcomeUnknown}
          onCancel={onClose}
          onDraftChange={persistNoticeDraft}
          onLoadPrevious={() => setReuseOpen(true)}
          onSubmit={(request) => void noticeCreate.submit(request)}
          selectedAudienceEnabled={selectedAudienceEnabled}
          showCompositionSteps
          showPublishSummary
          submitLabel={noticeCreate.outcomeUnknown ? "결과 다시 확인" : "올리기"}
        />
      ) : (
        <SupplyForm
          key={kind}
          busy={supplyCreate.busy}
          compositionHeader={kinds}
          focusTitleOnMount={!supplyCreate.outcomeUnknown}
          initialValue={supplyCreate.pendingRequest ?? supplyDraft}
          locked={supplyCreate.outcomeUnknown}
          onCancel={onClose}
          onDraftChange={persistSupplyDraft}
          onLoadPrevious={() => setReuseOpen(true)}
          onSubmit={(request) => {
            submittedCategoryRef.current = request.category ?? "general";
            void supplyCreate.submit(request);
          }}
          selectedAudienceEnabled={selectedAudienceEnabled}
          serverToday={serverToday}
          showCategorySelector={false}
          showCompositionSteps
          showPublishSummary
          submitLabel={supplyCreate.outcomeUnknown ? "결과 다시 확인" : "올리기"}
        />
      )}
      <ContentReusePicker
        open={reuseOpen}
        initialKind={kind === "homework" ? "homework" : "notice"}
        onClose={() => setReuseOpen(false)}
        onPick={(sourceKind, id) => {
          setReuseOpen(false);
          void navigate("/updates/reuse/" + sourceKind + "/" + encodeURIComponent(id));
        }}
      />
    </section>
  );
  return presentationDesktop ? panel : createPortal(panel, document.body);
}
