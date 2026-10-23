import type {
  AttendanceCounts,
  AttendanceNotificationItem,
} from "../attendance-notifications/attendance-notifications.types.js";
import type { NoticeConfirmationCounts } from "../notices/notices.types.js";
import type { SupplyCheckCounts } from "../supplies/supplies.types.js";

export type HomeCardStatus = "empty" | "error" | "ok";

export type HomeCard<T> =
  | { data: T; status: "empty" | "ok" }
  | { data: T; error_code: string; message: string; status: "error" };

export type HomeAttendanceData = AttendanceCounts | AttendanceNotificationItem | null;

export interface HomeMealMenuItem {
  allergens: string[];
  name: string;
}

export interface HomeMeal {
  calorie_kcal: number | null;
  id: string;
  meal_date: string;
  menu: HomeMealMenuItem[];
  source: "neis" | "seed";
  source_loaded_on: string | null;
  source_updated_at: string;
}

export interface HomeReminder {
  /*
   * 준비물일 때만 있다. 숙제는 준비물과 **같은 표**를 쓰고 링크도 같아서 종류를
   * 새로 만들 이유가 없다 — 다른 것은 "가져올 것 / 할 것"이라는 **말**뿐이다.
   * 이 칸이 없어서 재알림 화면이 숙제를 "준비물"이라고 부르고 있었다(2026-08-22 감사 BLUE-10).
   */
  category?: "general" | "homework";
  reminder_type: "notice" | "supply";
  requested_at: string;
  resource_id: string;
  title: string;
}

export type ConfirmationState = "confirmed" | "modified_unconfirmed" | "unread";
export type CheckState = "checked" | "modified_unconfirmed" | "unchecked";

export interface HomeNotice {
  confirmation_state?: ConfirmationState;
  content_revision: string;
  id: string;
  is_important: boolean;
  published_at: string;
  title: string;
}

/*
 * 홈의 "진행 중인 투표" 칸은 투표와 선거를 함께 싣는다 — 학생·교사 모두
 * 거기서 찾기 때문이다(2026-08-12 Hex: "진행중인 투표에 선거가 안 올라가 있어").
 * 종류가 다르면 눌렀을 때 갈 곳도 다르므로 kind 로 가른다.
 */
export type HomePollKind = "election" | "poll";

export interface HomePoll {
  /** 선거는 마감 시각이 없다 — 교사가 닫을 때까지 열려 있다. */
  closes_at: string | null;
  has_voted: boolean;
  id: string;
  kind: HomePollKind;
  title: string;
}

export interface HomeSupply {
  /*
   * 알림 카드가 "아직 안 한 숙제"만 따로 싣기 때문에 화면이 종류를 알아야 한다.
   * 2026-08-10에 한 번 뺐다가(그때는 쓰는 곳이 없었다) 이 쓰임이 생겨 되돌렸다.
   */
  category: "general" | "homework";
  check_state?: CheckState;
  content_revision: string;
  description: string | null;
  id: string;
  needed_on: string;
  title: string;
}

export interface HomeSchedule {
  d_day_label: string;
  days_until: number;
  due_date: string;
  id: string;
  schedule_type: "assignment" | "exam" | "other" | "performance";
  subject: string | null;
  title: string;
}

export interface TeacherHomeNoticeFollowup {
  content_revision: string;
  counts: NoticeConfirmationCounts;
  is_important: boolean;
  last_reminder_requested_at: string | null;
  published_at: string;
  resource_id: string;
  resource_type: "notice";
  title: string;
}

export interface TeacherHomeSupplyFollowup {
  /** 교사 후속확인 줄도 "가져올 것"과 "할 것"을 갈라 불러야 한다(BLUE-10). */
  category: "general" | "homework";
  content_revision: string;
  counts: SupplyCheckCounts;
  last_reminder_requested_at: string | null;
  needed_on: string;
  resource_id: string;
  resource_type: "supply";
  title: string;
}

export type TeacherHomeFollowup = TeacherHomeNoticeFollowup | TeacherHomeSupplyFollowup;

export interface HomeBirthday {
  display_name: string;
  member_id: string;
}

export interface HomeResult {
  /** 교사만: 승인된 학생 수(반 관리와 같은 기준). */
  active_student_count?: number;
  attendance?: HomeCard<HomeAttendanceData>;
  /** 생년월일 칸이 설치된 환경에서만. 오늘 생일이고 알리기를 켠 학생. */
  birthdays?: HomeCard<HomeBirthday[]>;
  meal: HomeCard<HomeMeal | null>;
  notices: HomeCard<HomeNotice[]>;
  pending_member_count: number | null;
  polls?: HomeCard<HomePoll[]>;
  reminders: HomeCard<HomeReminder[]>;
  schedules: HomeCard<HomeSchedule[]>;
  server_today: string;
  supplies: HomeCard<HomeSupply[]>;
  teacher_followups: HomeCard<TeacherHomeFollowup[]> | null;
  /** 학생만: 소식 탭 '안 한 것'과 같은 기준의 남은 공지·준비물 수. 셀 수 없으면 null. */
  unresolved_count?: number | null;
}
