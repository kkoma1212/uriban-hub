export type AllergenCode =
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "10"
  | "11"
  | "12"
  | "13"
  | "14"
  | "15"
  | "16"
  | "17"
  | "18"
  | "19";

export interface MealMenuItem {
  allergens: AllergenCode[];
  name: string;
}

export type MealSource = "neis" | "seed";

export interface MealItem {
  calorie_kcal: number | null;
  id: string;
  meal_date: string;
  menu: MealMenuItem[];
  source: MealSource;
  source_loaded_on: string | null;
  source_updated_at: string;
}

export type MealDayResult = { data: MealItem; status: "ok" } | { data: null; status: "empty" };

export type TodayMealResult = MealDayResult & { server_today: string };

export type WeekMealDay = MealDayResult & { date: string };

export interface WeekMealsResult {
  items: WeekMealDay[];
  server_today: string;
}

export type MonthMealDay = MealDayResult & { date: string };

export interface MonthMealsResult {
  items: MonthMealDay[];
  month: string;
  server_today: string;
}
