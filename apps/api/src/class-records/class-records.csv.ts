/*
 * 반 기록 내려받기(2026-10-23 사용자 결정 '선생님이 쓴 글만'): 공지·준비물·숙제·일정·투표를 CSV 한 파일로.
 * 학생 이름·번호·확인 현황·대화는 넣지 않는다 — 파일이 밖으로 나가도 학생 개인정보가 따라가지 않게.
 * 시각은 SQL에서 이미 한국 시각 문자열(YYYY-MM-DD HH:MM)로 만들어 온다.
 */

export interface NoticeRecord {
  category: string;
  title: string;
  content: string;
  audienceMode: string;
  important: boolean;
  scheduled: boolean;
  publishedAt: string;
  editedAt: string | null;
}

export interface SupplyRecord {
  category: string;
  title: string;
  description: string | null;
  neededOn: string;
  audienceMode: string;
  createdAt: string;
  editedAt: string | null;
}

export interface ScheduleRecord {
  scheduleType: string;
  title: string;
  subject: string | null;
  description: string | null;
  dueDate: string;
  createdAt: string;
  editedAt: string | null;
}

export interface PollRecord {
  title: string;
  description: string | null;
  closesAt: string;
  closedEarly: boolean;
  createdAt: string;
  voters: number;
  options: readonly { label: string; votes: number }[];
}

export interface ClassRecords {
  notices: readonly NoticeRecord[];
  supplies: readonly SupplyRecord[];
  schedules: readonly ScheduleRecord[];
  polls: readonly PollRecord[];
}

const CSV_HEADERS = [
  "종류",
  "제목",
  "내용",
  "날짜",
  "대상",
  "올린 시각",
  "마지막 수정 시각",
  "비고",
] as const;

const SCHEDULE_TYPE_LABELS: Readonly<Record<string, string>> = {
  exam: "시험",
  performance: "수행평가",
  assignment: "과제",
  other: "기타",
};

function audienceLabel(mode: string): string {
  return mode === "selected_snapshot" ? "일부 학생" : "반 전체";
}

/** 엑셀이 =·+·-·@로 시작하는 칸을 수식으로 실행하지 않게 앞에 '를 붙인다(평가 CSV와 같은 규칙). */
function safeCsvCell(value: string): string {
  const text = /^[\t\r ]*[=+\-@]/u.test(value) ? `'${value}` : value;
  return `"${text.replaceAll('"', '""')}"`;
}

function noticeRow(notice: NoticeRecord): string[] {
  const notes = [notice.important ? "중요" : "", notice.scheduled ? "예약 게시" : ""];
  return [
    notice.category === "performance" ? "공지(수행평가)" : "공지",
    notice.title,
    notice.content,
    "",
    audienceLabel(notice.audienceMode),
    notice.publishedAt,
    notice.editedAt ?? "",
    notes.filter(Boolean).join(" · "),
  ];
}

function supplyRow(supply: SupplyRecord): string[] {
  return [
    supply.category === "homework" ? "숙제" : "준비물",
    supply.title,
    supply.description ?? "",
    supply.neededOn,
    audienceLabel(supply.audienceMode),
    supply.createdAt,
    supply.editedAt ?? "",
    "",
  ];
}

function scheduleRow(schedule: ScheduleRecord): string[] {
  const typeLabel = SCHEDULE_TYPE_LABELS[schedule.scheduleType] ?? "기타";
  return [
    `일정(${typeLabel})`,
    schedule.title,
    schedule.description ?? "",
    schedule.dueDate,
    "반 전체",
    schedule.createdAt,
    schedule.editedAt ?? "",
    schedule.subject ? `과목: ${schedule.subject}` : "",
  ];
}

function pollRow(poll: PollRecord): string[] {
  const results = poll.options
    .map((option, index) => `${String(index + 1)}) ${option.label} ${String(option.votes)}표`)
    .join(" / ");
  const notes = [results, `참여 ${String(poll.voters)}명`, poll.closedEarly ? "일찍 마감" : ""];
  return [
    "투표",
    poll.title,
    poll.description ?? "",
    poll.closesAt,
    "반 전체",
    poll.createdAt,
    "",
    notes.filter(Boolean).join(" · "),
  ];
}

export function classRecordsCsv(records: ClassRecords): string {
  const rows = [
    ...records.notices.map(noticeRow),
    ...records.supplies.map(supplyRow),
    ...records.schedules.map(scheduleRow),
    ...records.polls.map(pollRow),
  ];
  return `\uFEFF${[CSV_HEADERS, ...rows]
    .map((row) => row.map((value) => safeCsvCell(value)).join(","))
    .join("\r\n")}\r\n`;
}
