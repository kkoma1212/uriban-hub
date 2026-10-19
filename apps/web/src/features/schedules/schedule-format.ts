import type { ScheduleType } from "../../api/schedules";

import { formatKstCalendarDate } from "../../lib/kst-format";

export function formatScheduleDate(value: string): string {
  return formatKstCalendarDate(value);
}

export const scheduleTypeLabel: Record<ScheduleType, string> = {
  assignment: "과제",
  exam: "시험",
  other: "기타",
  performance: "수행평가",
};
