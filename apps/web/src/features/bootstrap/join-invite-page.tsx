import { useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import {
  clearPendingInviteCode,
  normalizeInviteCode,
  storePendingInviteCode,
} from "../../lib/invite-link";
import { AppShell } from "../layout/app-shell";
import { PageHeader } from "../layout/page-header";

/** QR로 들어온 초대 코드를 담아 두고 참여 화면(로그인 필요 시 로그인)으로 보낸다. */
export function JoinInvitePage(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const code = normalizeInviteCode(searchParams.get("code"));
  useEffect(() => {
    // 저장이 끝난 뒤 이동해야 참여 화면이 코드를 읽을 수 있다.
    if (code === null) {
      clearPendingInviteCode();
      return;
    }
    storePendingInviteCode(code);
    void navigate("/bootstrap", { replace: true });
  }, [code, navigate]);
  if (code === null)
    return (
      <AppShell centered width="narrow">
        <section className="ui-panel" role="alert">
          <PageHeader
            eyebrow="반 참여"
            title="반 초대 링크를 확인해 주세요"
            description="초대 코드가 없거나 올바르지 않아요. 선생님에게 새 링크를 받거나 8자리 코드를 직접 입력해 주세요."
          />
          <p className="mt-3 text-sm leading-6 text-app-muted">
            로그인이 필요하면 먼저 로그인한 뒤 코드를 입력해 주세요.
          </p>
          <Link className="ui-button ui-button-primary mt-5 min-h-12 w-full" to="/bootstrap">
            초대 코드 직접 입력
          </Link>
        </section>
      </AppShell>
    );
  return (
    <p className="p-6 text-sm text-app-muted" role="status">
      반 참여 화면으로 이동하고 있어요.
    </p>
  );
}
