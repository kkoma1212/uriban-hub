import { useSyncExternalStore } from "react";

import type { BootstrapResponse } from "../api/auth";

interface NavigationCapabilities {
  studentAssessmentsEnabled: boolean;
  attendanceNotificationsEnabled: boolean;
  /** 서버가 확인한 담임일 때만 true — 교사 화면 틀이 교사용 숫자를 묻기 전 역할 확인용 */
  confirmedTeacher: boolean;
  /** 서버가 USE_PROFILE_PHOTOS를 줄 때만 true — 꺼져 있으면 목록마다 사진을 요청하지 않는다(T-PHOTO). */
  profilePhotosEnabled: boolean;
  /** 사진이 켜졌을 때의 현재 반 — 학생 쪽 도움 대화가 담임 사진 주소를 만들 때 쓴다. */
  profilePhotoClassId: string | null;
  /** 서버가 USE_CLASS_CHAT을 줄 때만 true — PC 왼쪽 메뉴에 반 대화를 보인다(휴대폰은 더보기 타일). */
  classChatEnabled: boolean;
  /**
   * 투표·선거 권한이 하나라도 있을 때만 true — 둘 다 꺼진 반은 '반 활동'이 빈 화면이라 메뉴를
   * 감춘다(총검수 A3-03). 권한을 아직 모를 때는 지금처럼 보이게 true로 둔다(깜빡임 방지).
   */
  activitiesEnabled: boolean;
}

const emptyCapabilities: NavigationCapabilities = {
  studentAssessmentsEnabled: false,
  attendanceNotificationsEnabled: false,
  confirmedTeacher: false,
  profilePhotosEnabled: false,
  profilePhotoClassId: null,
  classChatEnabled: false,
  activitiesEnabled: true,
};

let currentCapabilities = emptyCapabilities;
const listeners = new Set<() => void>();
let requestEpoch = 0;

function emitChange(): void {
  for (const listener of listeners) listener();
}

export function beginNavigationCapabilitiesRequest(): number {
  requestEpoch += 1;
  return requestEpoch;
}

export function rememberNavigationCapabilities(
  epoch: number,
  bootstrap: Pick<BootstrapResponse, "allowed_actions" | "current_membership">,
): void {
  if (epoch !== requestEpoch) return;
  const studentAssessmentsEnabled =
    bootstrap.current_membership?.role === "student" &&
    bootstrap.allowed_actions.includes("MANAGE_OWN_ASSESSMENTS");
  const attendanceNotificationsEnabled = bootstrap.allowed_actions.some(
    (action) =>
      action === "MANAGE_ATTENDANCE_NOTIFICATIONS" ||
      action === "MANAGE_OWN_ATTENDANCE_NOTIFICATION",
  );
  const confirmedTeacher =
    bootstrap.current_membership?.role === "teacher" &&
    bootstrap.current_membership.status === "approved";
  const profilePhotosEnabled = bootstrap.allowed_actions.includes("USE_PROFILE_PHOTOS");
  const profilePhotoClassId = profilePhotosEnabled
    ? (bootstrap.current_membership?.class_id ?? null)
    : null;
  const classChatEnabled = bootstrap.allowed_actions.includes("USE_CLASS_CHAT");
  const activitiesEnabled = bootstrap.allowed_actions.some(
    (action) =>
      action === "MANAGE_POLLS" ||
      action === "VOTE_IN_POLLS" ||
      action === "MANAGE_ELECTIONS" ||
      action === "VOTE_IN_ELECTIONS",
  );
  if (
    currentCapabilities.studentAssessmentsEnabled === studentAssessmentsEnabled &&
    currentCapabilities.attendanceNotificationsEnabled === attendanceNotificationsEnabled &&
    currentCapabilities.confirmedTeacher === confirmedTeacher &&
    currentCapabilities.profilePhotosEnabled === profilePhotosEnabled &&
    currentCapabilities.profilePhotoClassId === profilePhotoClassId &&
    currentCapabilities.classChatEnabled === classChatEnabled &&
    currentCapabilities.activitiesEnabled === activitiesEnabled
  )
    return;
  currentCapabilities = {
    studentAssessmentsEnabled,
    attendanceNotificationsEnabled,
    confirmedTeacher,
    profilePhotosEnabled,
    profilePhotoClassId,
    classChatEnabled,
    activitiesEnabled,
  };
  emitChange();
}

export function clearNavigationCapabilities(epoch?: number): void {
  if (epoch !== undefined && epoch !== requestEpoch) return;
  requestEpoch += 1;
  if (
    !currentCapabilities.studentAssessmentsEnabled &&
    !currentCapabilities.attendanceNotificationsEnabled &&
    !currentCapabilities.confirmedTeacher &&
    !currentCapabilities.profilePhotosEnabled &&
    !currentCapabilities.classChatEnabled &&
    currentCapabilities.activitiesEnabled
  ) {
    currentCapabilities = emptyCapabilities;
    return;
  }
  currentCapabilities = emptyCapabilities;
  emitChange();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): NavigationCapabilities {
  return currentCapabilities;
}

export function useNavigationCapabilities(): NavigationCapabilities {
  return useSyncExternalStore(subscribe, getSnapshot, () => emptyCapabilities);
}
