import { apiFetch, parseResponse } from "./auth";

export interface MealMenuItem {
  allergens: string[];
  name: string;
}

export interface MealItem {
  calorie_kcal: number | null;
  id: string;
  meal_date: string;
  menu: MealMenuItem[];
  source: "neis" | "seed";
  source_loaded_on: string | null;
  source_updated_at: string;
}

export type MealDayResult = { data: MealItem; status: "ok" } | { data: null; status: "empty" };

export type TodayMealResponse = MealDayResult & { server_today: string };

export type WeekMealDay = MealDayResult & { date: string };

export interface WeekMealsResponse {
  items: WeekMealDay[];
  server_today: string;
}

export type MonthMealDay = MealDayResult & { date: string };

export interface MonthMealsResponse {
  items: MonthMealDay[];
  month: string;
  server_today: string;
}

export async function getTodayMeal(): Promise<TodayMealResponse> {
  const response = await apiFetch("/api/v1/meals/today", { credentials: "include" });
  return parseResponse<TodayMealResponse>(response);
}

export async function getWeekMeals(): Promise<WeekMealsResponse> {
  const response = await apiFetch("/api/v1/meals/week", { credentials: "include" });
  return parseResponse<WeekMealsResponse>(response);
}

export async function getMonthMeals(month: string): Promise<MonthMealsResponse> {
  const response = await apiFetch(`/api/v1/meals/month?month=${month}`, {
    credentials: "include",
  });
  return parseResponse<MonthMealsResponse>(response);
}
