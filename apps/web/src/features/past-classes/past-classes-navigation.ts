import { useEffect, useState } from "react";

import { getBootstrap } from "../../api/auth";

/**
 * 지난 반 화면에도 지금 반의 아래 탭·왼쪽 메뉴를 보여 준다(총검수 B2-06: 메뉴가 사라지고
 * '처음으로'만 남았다). 지금 들어가 있는 반이 없으면 메뉴 없이 둔다.
 */
export function usePastClassNavigationRole(): "student" | "teacher" | undefined {
  const [role, setRole] = useState<"student" | "teacher">();
  useEffect(() => {
    let active = true;
    getBootstrap().then(
      (bootstrap) => {
        if (active && bootstrap.destination === "HOME") setRole(bootstrap.current_membership?.role);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, []);
  return role;
}
