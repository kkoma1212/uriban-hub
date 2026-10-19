/*
 * 알림을 보내도 되는 가장 이른 시각(한국 시간 기준).
 * 2026-03부터 수업 중 학생 스마트기기 사용이 법으로 금지돼, 수업 시간과 밤에는 보류한다.
 *
 * 기본값(2026-09-23 가정, 사용자 확정 전): 평일 08:20~16:40 수업 보류 → 16:40,
 * 매일 21:00~07:00 밤 보류 → 07:00. 공휴일·방학·학교별 시간표는 아직 반영하지 않는다.
 */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export const QUIET_HOURS = Object.freeze({
  classStartMinute: 8 * 60 + 20,
  classEndMinute: 16 * 60 + 40,
  nightStartMinute: 21 * 60,
  morningMinute: 7 * 60,
});

/** KST 날짜(자정)를 UTC 시각으로 바꾼 뒤 그날의 분을 더한다. */
function kstMinuteToUtc(kstMidnightUtcMs: number, minute: number): Date {
  return new Date(kstMidnightUtcMs + minute * MINUTE_MS);
}

export function nextDeliverableAt(now: Date): Date {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const minute = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const weekday = kst.getUTCDay(); // 0 일요일 … 6 토요일
  const kstMidnightUtcMs =
    Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - KST_OFFSET_MS;
  const { classStartMinute, classEndMinute, nightStartMinute, morningMinute } = QUIET_HOURS;

  if (minute >= nightStartMinute) {
    return kstMinuteToUtc(kstMidnightUtcMs + 24 * 60 * MINUTE_MS, morningMinute);
  }
  if (minute < morningMinute) return kstMinuteToUtc(kstMidnightUtcMs, morningMinute);
  const schoolDay = weekday >= 1 && weekday <= 5;
  if (schoolDay && minute >= classStartMinute && minute < classEndMinute) {
    return kstMinuteToUtc(kstMidnightUtcMs, classEndMinute);
  }
  return now;
}
