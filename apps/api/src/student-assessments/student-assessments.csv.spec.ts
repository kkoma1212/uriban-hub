import { describe, expect, it } from "vitest";

import { studentAssessmentsCsv } from "./student-assessments.csv.js";
import type { StudentAssessmentItem } from "./student-assessments.types.js";

const item: StudentAssessmentItem = {
  academic_year: 2026,
  assessment_date: "2026-07-20",
  assessment_type: "performance",
  created_at: "2026-07-30T00:00:00.000Z",
  expires_at: "2027-07-30T00:00:00.000Z",
  id: "1",
  max_score_hundredths: 10_000,
  memo: "발표, 보고서",
  recorded_at: "2026-07-30T00:00:00.000Z",
  row_version: "2",
  score_hundredths: 9_250,
  semester: 1,
  status: "recorded",
  subject: "수학",
  title: "주제 탐구",
  updated_at: "2026-07-30T00:00:00.000Z",
  weight_basis_points: 2_000,
};

describe("studentAssessmentsCsv", () => {
  it("uses a UTF-8 BOM, stable decimals, quoting, and weighted points", () => {
    const csv = studentAssessmentsCsv([item]);

    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"92.5","100","20","18.5"');
    expect(csv).toContain('"발표, 보고서"');
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it.each(["=1+1", "+SUM(A1)", "-2+3", "@cmd", '  =HYPERLINK("x")'])(
    "neutralizes spreadsheet formula input %s",
    (title) => {
      const csv = studentAssessmentsCsv([{ ...item, title }]);
      expect(csv).toContain(`"'${title.replaceAll('"', '""')}"`);
    },
  );
});
