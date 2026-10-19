// 나이스 학사일정 조회·검증은 공용 패키지로 옮겼다(2026-09-30, 웹 서버의 바로 가져오기와 함께 쓴다).
// 운영자 명령·검사가 쓰던 이름을 그대로 이어 준다.
export {
  fetchNeisSchoolSchedules,
  NeisSchoolScheduleError,
  parseNeisSchoolScheduleResponse,
  validateNeisSchoolScheduleQuery,
  type FetchNeisSchoolSchedulesOptions,
  type NeisSchoolSchedule,
  type NeisSchoolScheduleQuery,
  type ValidatedNeisSchoolScheduleQuery,
} from "@classhub/neis";
