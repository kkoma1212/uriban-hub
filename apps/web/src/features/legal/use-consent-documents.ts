import { useCallback, useEffect, useState } from "react";
import { getLegalConsentBundle, type LegalConsentSnapshot } from "./legal-api";
import { LEGAL_DOCUMENTS } from "./legal-documents";

export function useConsentDocuments(enabled = true) {
  const [ready, setReady] = useState(!enabled);
  const [documents, setDocuments] = useState<LegalConsentSnapshot>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => {
    setReady(false);
    setDocuments(undefined);
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setReady(false);
    setError(undefined);
    void getLegalConsentBundle()
      .then((bundle) => {
        if (!active) return;
        if (
          typeof bundle.binding_required !== "boolean" ||
          (bundle.binding_required &&
            (!bundle.documents ||
              LEGAL_DOCUMENTS.some((item) => !bundle.documents?.[item.type]?.policy_version)))
        ) {
          throw new Error("동의 대상 문서를 확인하지 못했어요.");
        }
        setDocuments(bundle.binding_required ? bundle.documents! : undefined);
        setReady(true);
      })
      .catch(() => {
        if (active) {
          setDocuments(undefined);
          setError("동의 대상 문서를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.");
        }
      });
    return () => {
      active = false;
    };
  }, [enabled, attempt]);
  return { ready, documents, error, reload };
}
