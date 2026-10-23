import { describe, expect, it } from "vitest";

import { classRecordsCsv, type ClassRecords } from "./class-records.csv.js";

const empty: ClassRecords = { notices: [], supplies: [], schedules: [], polls: [] };

function lines(csv: string): string[] {
  expect(csv.startsWith("\uFEFF")).toBe(true);
  expect(csv.endsWith("\r\n")).toBe(true);
  return csv.slice(1, -2).split("\r\n");
}

describe("classRecordsCsv", () => {
  it("빈 반은 머리줄만 남긴다", () => {
    expect(lines(classRecordsCsv(empty))).toEqual([
      '"종류","제목","내용","날짜","대상","올린 시각","마지막 수정 시각","비고"',
    ]);
  });

  it("종류마다 한국어 이름·대상·비고를 적고 공지→준비물→일정→투표 순서로 쓴다", () => {
    const csv = classRecordsCsv({
      notices: [
        {
          category: "performance",
          title: "수행평가 안내",
          content: '준비물은 "자"와\n각도기',
          audienceMode: "selected_snapshot",
          important: true,
          scheduled: true,
          publishedAt: "2026-10-23 09:00",
          editedAt: "2026-10-23 10:30",
        },
      ],
      supplies: [
        {
          category: "homework",
          title: "수학 익힘책",
          description: null,
          neededOn: "2026-10-24",
          audienceMode: "all_snapshot",
          createdAt: "2026-10-22 18:00",
          editedAt: null,
        },
      ],
      schedules: [
        {
          scheduleType: "exam",
          title: "중간고사",
          subject: "국어",
          description: "1~3단원",
          dueDate: "2026-10-30",
          createdAt: "2026-10-01 08:00",
          editedAt: null,
        },
      ],
      polls: [
        {
          title: "체험학습 장소",
          description: null,
          closesAt: "2026-10-25 17:00",
          closedEarly: true,
          createdAt: "2026-10-20 12:00",
          voters: 8,
          options: [
            { label: "과학관", votes: 3 },
            { label: "미술관", votes: 5 },
          ],
        },
      ],
    });
    expect(lines(csv).slice(1)).toEqual([
      '"공지(수행평가)","수행평가 안내","준비물은 ""자""와\n각도기","","일부 학생","2026-10-23 09:00","2026-10-23 10:30","중요 · 예약 게시"',
      '"숙제","수학 익힘책","","2026-10-24","반 전체","2026-10-22 18:00","",""',
      '"일정(시험)","중간고사","1~3단원","2026-10-30","반 전체","2026-10-01 08:00","","과목: 국어"',
      '"투표","체험학습 장소","","2026-10-25 17:00","반 전체","2026-10-20 12:00","","1) 과학관 3표 / 2) 미술관 5표 · 참여 8명 · 일찍 마감"',
    ]);
  });

  it("엑셀이 수식으로 읽을 칸(=·+·-·@, 앞 공백 포함)은 '로 막는다", () => {
    const csv = classRecordsCsv({
      ...empty,
      supplies: ["=HYPERLINK(1)", "+1", " -2+3", "@SUM(A1)", "안전한 글"].map((title) => ({
        category: "general",
        title,
        description: null,
        neededOn: "2026-10-24",
        audienceMode: "legacy_class",
        createdAt: "2026-10-22 18:00",
        editedAt: null,
      })),
    });
    expect(lines(csv).map((line) => line.split(",")[1])).toEqual([
      '"제목"',
      `"'=HYPERLINK(1)"`,
      `"'+1"`,
      `"' -2+3"`,
      `"'@SUM(A1)"`,
      '"안전한 글"',
    ]);
  });

  it("알 수 없는 일정 종류는 기타로 적는다", () => {
    const csv = classRecordsCsv({
      ...empty,
      schedules: [
        {
          scheduleType: "unknown",
          title: "행사",
          subject: null,
          description: null,
          dueDate: "2026-11-01",
          createdAt: "2026-10-01 08:00",
          editedAt: null,
        },
      ],
    });
    expect(lines(csv)[1]).toBe(
      '"일정(기타)","행사","","2026-11-01","반 전체","2026-10-01 08:00","",""',
    );
  });
});
