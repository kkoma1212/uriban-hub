import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { ApiRequestError, getBootstrap } from "../../api/auth";
import { AppShell, AppShellBar, type AppNavigationRole } from "../layout/app-shell";
import { PageHeader } from "../layout/page-header";
import { SocialConnectionsPanel } from "./social-connections-panel";

/*
 * 2026-10-01 사용자 요청: 빠른 로그인 연결을 '내 이름 변경' 안에서 꺼내 설정의 별도 줄과 화면으로 둔다.
 * 연결을 마치고 돌아오는 곳도 이 화면이다(API social_linked 돌아오기 주소).
 */
export function SocialConnectionsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [role, setRole] = useState<AppNavigationRole>();
  const [roleChecked, setRoleChecked] = useState(false);
  useEffect(() => {
    let active = true;
    void getBootstrap()
      .then((bootstrap) => {
        if (!active) return;
        setRole(
          bootstrap.current_membership?.role ??
            (bootstrap.teacher_profile === null ? "student" : "teacher"),
        );
        setRoleChecked(true);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiRequestError && error.status === 401)
          void navigate("/login", { replace: true });
        else setRoleChecked(true);
      });
    return () => {
      active = false;
    };
  }, [navigate]);

  return (
    <AppShell {...(role === undefined ? {} : { navigationRole: role })} width="narrow">
      <AppShellBar backLabel="설정으로" backTo="/settings" brandTo="/home" context="빠른 로그인" />
      <PageHeader
        description="구글·카카오·네이버 계정을 연결하면 다음부터 버튼 하나로 로그인해요."
        eyebrow="내 계정"
        title="빠른 로그인 연결"
      />
      {/* 역할이 정해지면 AppShell이 본문을 사이드바 격자로 옮기며 다시 만든다. 그 전에 패널을 그리면 먼저 누른
          해제 결과 안내가 지워지므로(T-SHELL-REMOUNT, 2026-10-21 재현) bootstrap 조회가 끝난 뒤에 그린다. */}
      {roleChecked ? <SocialConnectionsPanel /> : null}
    </AppShell>
  );
}
