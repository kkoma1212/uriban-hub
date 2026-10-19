import {
  Activity,
  LayoutDashboard,
  MessageSquareText,
  RefreshCw,
  School,
  UserPlus,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type * as React from "react";

import {
  adminOverviewServiceLabel,
  getAdminOverview,
  type AdminOverview,
} from "../../api/admin-overview";
import {
  AttentionStrip,
  RecentSignups,
  TrendSection,
  type DashboardTarget,
} from "./admin-console-dashboard";
import { adminErrorMessage, formatDateTime, LoadState, PanelFrame } from "./admin-console-shared";

type OverviewTarget = DashboardTarget;

function Stat({
  label,
  tone = "normal",
  value,
}: {
  label: string;
  tone?: "attention" | "normal";
  value: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-card bg-app-surface-muted px-3 py-2.5" data-admin-stat>
      <dt className="text-xs font-semibold text-app-muted">{label}</dt>
      <dd
        className={
          "mt-0.5 text-xl font-extrabold tabular-nums " +
          (tone === "attention" ? "text-danger-text" : "text-app-text")
        }
      >
        {value}
      </dd>
    </div>
  );
}

function Card({
  children,
  icon: Icon,
  onOpen,
  openLabel,
  title,
}: {
  children: React.ReactNode;
  icon: typeof Activity;
  onOpen?: () => void;
  openLabel?: string;
  title: string;
}): React.JSX.Element {
  return (
    <section className="rounded-card border border-app-border bg-app-surface p-4" data-admin-card>
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-extrabold text-app-text">
          <Icon aria-hidden="true" size={17} /> {title}
        </h3>
        {onOpen ? (
          <button className="ui-button ui-button-secondary text-xs" onClick={onOpen} type="button">
            {openLabel}
          </button>
        ) : null}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">{children}</dl>
    </section>
  );
}

function uptime(startedAt: string, now: string): string {
  const minutes = Math.max(0, Math.floor((Date.parse(now) - Date.parse(startedAt)) / 60_000));
  if (minutes < 60) return minutes + "분";
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? hours + "시간" : Math.floor(hours / 24) + "일";
}

/** 첫 화면(대시보드): 확인할 것 띠 → 숫자 카드 4묶음 → 기간 추이 → 최근 가입. 바로가기는 볼 수 있는 탭만. */
export function OverviewPanel({
  canOpen,
  onOpen,
}: {
  canOpen: (target: OverviewTarget) => boolean;
  onOpen: (target: OverviewTarget) => void;
}): React.JSX.Element {
  const [overview, setOverview] = useState<AdminOverview>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      setOverview(await getAdminOverview());
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "현황을 불러오지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const link = (target: OverviewTarget, label: string) =>
    canOpen(target) ? { onOpen: () => onOpen(target), openLabel: label } : {};

  return (
    <PanelFrame
      description="개인 정보 없이 숫자만 모았습니다. 자세한 내용은 각 바로가기에서 확인합니다."
      icon={LayoutDashboard}
      title="한눈에 보기"
    >
      <LoadState
        error={error}
        loading={loading && overview === undefined}
        onRetry={() => void load()}
      />
      {overview ? (
        <>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-app-muted">
            <span>{formatDateTime(overview.generated_at)} 기준</span>
            <button
              aria-busy={loading}
              className="ui-button ui-button-secondary text-xs"
              disabled={loading}
              onClick={() => void load()}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={15} /> 새로 보기
            </button>
          </div>
          <AttentionStrip canOpen={canOpen} onOpen={onOpen} overview={overview} />
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <Card icon={UserPlus} title="가입·승인" {...link("approvals", "승인번호")}>
              <Stat
                label="승인 기다리는 선생님"
                tone={overview.signups.pending_teachers > 0 ? "attention" : "normal"}
                value={overview.signups.pending_teachers}
              />
              <Stat label="메일 인증 전 학생" value={overview.signups.pending_students} />
              <Stat label="최근 7일 새 가입" value={overview.signups.new_last_7_days} />
            </Card>
            <Card icon={School} title="학교·반·사용자" {...link("members", "계정 관리")}>
              <Stat label="학교" value={overview.scale.schools} />
              <Stat label="운영 중인 반" value={overview.scale.active_classes} />
              <Stat label="선생님" value={overview.scale.teachers} />
              <Stat label="학생" value={overview.scale.students} />
              <Stat label="사용 중인 계정" value={overview.scale.active_users} />
            </Card>
            <Card
              icon={Activity}
              title={adminOverviewServiceLabel(overview.server) + "·오류"}
              {...link("system", "시스템 상태")}
            >
              <Stat
                label="DB 응답"
                tone={overview.server.database_ms === null ? "attention" : "normal"}
                value={
                  overview.server.database_ms === null
                    ? "응답 없음"
                    : overview.server.database_ms + "ms"
                }
              />
              <Stat
                label="세션 저장소"
                tone={overview.server.redis_ok ? "normal" : "attention"}
                value={overview.server.redis_ok ? "정상" : "응답 없음"}
              />
              <Stat
                label="최근 1시간 서버 오류"
                tone={overview.server.errors_last_hour > 0 ? "attention" : "normal"}
                value={overview.server.errors_last_hour + "건"}
              />
              <Stat
                label="점검 모드"
                tone={overview.server.maintenance_mode !== false ? "attention" : "normal"}
                value={
                  overview.server.maintenance_mode === null
                    ? "확인 불가"
                    : overview.server.maintenance_mode
                      ? "켜짐"
                      : "꺼짐"
                }
              />
              <Stat
                label="켜진 지"
                value={uptime(overview.server.started_at, overview.generated_at)}
              />
              <Stat label="메모리" value={overview.server.memory_mb + "MB"} />
            </Card>
            <Card icon={MessageSquareText} title="문의·신고" {...link("inquiries", "문의")}>
              <Stat
                label="새 문의"
                tone={overview.support.inquiries_open > 0 ? "attention" : "normal"}
                value={overview.support.inquiries_open}
              />
              <Stat label="처리 중 문의" value={overview.support.inquiries_in_progress} />
              <Stat
                label="반 대화 열린 신고"
                value={
                  overview.support.class_chat_reports_open === null
                    ? "꺼짐"
                    : overview.support.class_chat_reports_open
                }
              />
            </Card>
          </div>
          <p className="mt-3 text-xs leading-5 text-app-muted">
            {adminOverviewServiceLabel(overview.server)}의 오류·가동 시간·메모리는 현재 응답한
            서비스 기준입니다. 다른 서비스의 오류는 합산하지 않습니다. 오류 수는 이 서비스가 켜진
            뒤부터 셉니다(재시작하면 0). 반 대화 신고는 각 반 담임이 처리하며, 여기서는 수만 봅니다.
          </p>
          <TrendSection />
          <RecentSignups canOpen={canOpen} onOpen={onOpen} />
        </>
      ) : null}
    </PanelFrame>
  );
}
