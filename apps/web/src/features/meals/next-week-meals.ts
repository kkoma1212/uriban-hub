import { getMonthMeals, getWeekMeals, type WeekMealsResponse } from "../../api/meals";

/** 기기 날짜 대신 서버의 이번 주를 기준으로 다음 주 평일을 고른다. */
export async function getNextWeekMeals(): Promise<WeekMealsResponse> {
  const { server_today } = await getWeekMeals();
  const monday = new Date(`${server_today}T00:00:00.000Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) + 7);
  const dates = Array.from({ length: 5 }, (_, index) => {
    const date = new Date(monday);
    date.setUTCDate(monday.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
  const months = [...new Set(dates.map((date) => date.slice(0, 7)))];
  const results = await Promise.all(months.map(getMonthMeals));
  const days = new Map(
    results.flatMap((month) => month.items.map((day) => [day.date, day] as const)),
  );
  return {
    server_today,
    items: dates.map((date) => days.get(date) ?? { date, status: "empty", data: null }),
  };
}
