import type { StudentAssessmentItem } from "./student-assessments.types.js";

const CSV_HEADERS = [
  "학년도",
  "학기",
  "구분",
  "과목",
  "평가명",
  "평가일",
  "받은 점수",
  "만점",
  "가중치(%)",
  "환산점수",
  "메모",
  "기록 완료 시각",
  "보관 만료 시각",
] as const;

function decimalHundredths(value: number | null): string {
  if (value === null) return "";
  return (value / 100).toFixed(2).replace(/\.?0+$/u, "");
}

function weightedScore(item: StudentAssessmentItem): string {
  if (
    item.score_hundredths === null ||
    item.max_score_hundredths === null ||
    item.weight_basis_points === null
  ) {
    return "";
  }
  const value =
    (item.score_hundredths / item.max_score_hundredths) * (item.weight_basis_points / 100);
  return value.toFixed(2).replace(/\.?0+$/u, "");
}

function safeCsvCell(value: string | number | null): string {
  let text = value === null ? "" : String(value);
  if (/^[\t\r ]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function studentAssessmentsCsv(items: readonly StudentAssessmentItem[]): string {
  const rows = items.map((item) => [
    item.academic_year,
    item.semester,
    item.assessment_type === "performance" ? "수행평가" : "지필평가",
    item.subject,
    item.title,
    item.assessment_date,
    decimalHundredths(item.score_hundredths),
    decimalHundredths(item.max_score_hundredths),
    item.weight_basis_points === null ? "" : item.weight_basis_points / 100,
    weightedScore(item),
    item.memo,
    item.recorded_at,
    item.expires_at,
  ]);
  return `\uFEFF${[CSV_HEADERS, ...rows]
    .map((row) => row.map((value) => safeCsvCell(value)).join(","))
    .join("\r\n")}\r\n`;
}
