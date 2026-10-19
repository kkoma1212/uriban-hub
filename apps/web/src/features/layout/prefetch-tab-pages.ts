/*
 * 2026-10-01 성능 측정(느린 4G + 휴대폰 CPU): 탭을 처음 열 때 그 화면 코드(약 100KB)를 그제야 받아
 * 소식 0.9~1.1초, 일정·설정 0.5~0.7초가 걸렸다. 홈을 다 그린 뒤 브라우저가 한가할 때 자주 가는
 * 탭의 코드만 하나씩 미리 받아 둔다. 라우터와 같은 import라 받은 코드는 그대로 다시 쓰인다.
 * 데이터는 미리 받지 않는다(권한·최신성은 각 화면이 열릴 때 확인).
 */
type Loader = () => Promise<unknown>;

const SHARED: Loader[] = [
  () => import("../updates/updates-page"),
  () => import("../schedules/schedules-page"),
  () => import("../activities/activities-page"),
  () => import("../attendance/attendance-page"),
  () => import("../meals/meals-page"),
  () => import("../more/more-page"),
  () => import("../settings/student-settings-page"),
];

const BY_ROLE: Record<"student" | "teacher", Loader[]> = {
  student: [
    () => import("../help-requests/help-thread-page"),
    () => import("../assessments/student-assessments-page"),
  ],
  teacher: [
    () => import("../members/member-management-page"),
    () => import("../help-requests/help-requests-page"),
    () => import("../classes/teacher-class-management-page"),
  ],
};

interface NetworkInformationLike {
  effectiveType?: string;
  saveData?: boolean;
}

/** 데이터 절약 모드·2G에서는 미리 받지 않는다. */
function prefetchAllowed(): boolean {
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  if (connection?.saveData === true) return false;
  return !["slow-2g", "2g"].includes(connection?.effectiveType ?? "");
}

function whenIdle(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(callback, { timeout: 3000 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(callback, 1200);
  return () => window.clearTimeout(handle);
}

/** 홈을 그린 뒤 한 번 부른다. 돌려받은 함수로 남은 미리 받기를 멈춘다. */
export function prefetchTabPages(role: "student" | "teacher"): () => void {
  if (!prefetchAllowed()) return () => undefined;
  const queue = [...BY_ROLE[role].slice(0, 1), ...SHARED, ...BY_ROLE[role].slice(1)];
  let cancelled = false;
  let cancelIdle = whenIdle(next);
  // 한꺼번에 받으면 휴대폰 회선을 나눠 쓰니 하나씩, 한가할 때마다 받는다.
  function next(): void {
    const load = queue.shift();
    if (cancelled || load === undefined) return;
    void load()
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) cancelIdle = whenIdle(next);
      });
  }
  return () => {
    cancelled = true;
    cancelIdle();
  };
}
