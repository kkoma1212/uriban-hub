import { Download, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

import { ApiRequestError } from "../../api/auth";
import { downloadClassRecordsCsv } from "../../api/class-records";
import { saveBlobAsFile } from "../../lib/save-blob";

function kstToday(): string {
  // sv-SE는 YYYY-MM-DD 모양으로 적는다.
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date());
}

/**
 * 반 기록 내려받기(2026-10-23 사용자 결정 '선생님이 쓴 글만'). 지금 반(반 운영 종료 화면)과
 * 끝난 반(지난 반 화면, 담임만)에서 같이 쓴다. 학생 이름·확인 현황은 파일에 들어가지 않는다.
 */
export function ClassRecordsDownload({ pastClassId }: { pastClassId?: string }): React.JSX.Element {
  const navigate = useNavigate();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string>();

  async function download(): Promise<void> {
    setDownloading(true);
    setError(undefined);
    try {
      saveBlobAsFile(await downloadClassRecordsCsv(pastClassId), `반-기록-${kstToday()}.csv`);
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      setError(
        requestError instanceof Error ? requestError.message : "반 기록을 내려받지 못했어요.",
      );
    } finally {
      setDownloading(false);
    }
  }

  return (
    <section
      aria-labelledby="class-records-download-title"
      className="rounded-2xl border border-app-border bg-app-surface p-4 text-sm leading-6"
    >
      <h2 className="font-black text-app-text" id="class-records-download-title">
        반 기록 내려받기
      </h2>
      <p className="mt-1 break-keep text-app-muted" id="class-records-download-description">
        선생님이 쓴 공지·준비물·숙제·일정과 투표 결과(선택지별 표 수)를 엑셀에서 열 수 있는 CSV
        파일로 받아요. 학생 이름과 확인 현황은 들어가지 않아요.
      </p>
      <button
        aria-describedby="class-records-download-description"
        className="ui-button ui-button-secondary mt-3 text-sm"
        disabled={downloading}
        onClick={() => void download()}
        type="button"
      >
        {downloading ? (
          <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
        ) : (
          <Download aria-hidden="true" size={17} />
        )}
        반 기록 CSV 받기
      </button>
      {error === undefined ? null : (
        <p className="mt-2 text-sm font-bold text-danger" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
