import { ApiProperty } from "@nestjs/swagger";

import type { AllergenCode } from "./meals.types.js";

const ALLERGEN_CODES: AllergenCode[] = Array.from(
  { length: 19 },
  (_, index) => String(index + 1) as AllergenCode,
);

export class MealMenuItemResponseDto {
  @ApiProperty({ enum: ALLERGEN_CODES, isArray: true })
  allergens!: AllergenCode[];

  @ApiProperty({ maxLength: 100, type: String })
  name!: string;
}

export class MealItemResponseDto {
  @ApiProperty({
    example: 1452.2,
    maximum: 9999.9,
    minimum: 0,
    nullable: true,
    type: Number,
  })
  calorie_kcal!: number | null;

  @ApiProperty({ example: "1", pattern: "^[1-9][0-9]*$", type: String })
  id!: string;

  @ApiProperty({ example: "2026-07-14", format: "date", type: String })
  meal_date!: string;

  @ApiProperty({ type: () => [MealMenuItemResponseDto] })
  menu!: MealMenuItemResponseDto[];

  @ApiProperty({ enum: ["neis", "seed"] })
  source!: "neis" | "seed";

  @ApiProperty({
    example: "2026-07-29",
    format: "date",
    nullable: true,
    type: String,
  })
  source_loaded_on!: string | null;

  @ApiProperty({ example: "2026-07-14T03:00:00.000Z", format: "date-time", type: String })
  source_updated_at!: string;
}

export class TodayMealResponseDto {
  @ApiProperty({ nullable: true, type: () => MealItemResponseDto })
  data!: MealItemResponseDto | null;

  @ApiProperty({ example: "2026-07-14", format: "date", type: String })
  server_today!: string;

  @ApiProperty({ enum: ["ok", "empty"] })
  status!: "empty" | "ok";
}

export class WeekMealDayResponseDto {
  @ApiProperty({ nullable: true, type: () => MealItemResponseDto })
  data!: MealItemResponseDto | null;

  @ApiProperty({ example: "2026-07-14", format: "date", type: String })
  date!: string;

  @ApiProperty({ enum: ["ok", "empty"] })
  status!: "empty" | "ok";
}

export class WeekMealsResponseDto {
  @ApiProperty({ maxItems: 5, minItems: 5, type: () => [WeekMealDayResponseDto] })
  items!: WeekMealDayResponseDto[];

  @ApiProperty({ example: "2026-07-14", format: "date", type: String })
  server_today!: string;
}

export class MonthMealDayResponseDto {
  @ApiProperty({ nullable: true, type: () => MealItemResponseDto })
  data!: MealItemResponseDto | null;

  @ApiProperty({ example: "2026-07-14", format: "date", type: String })
  date!: string;

  @ApiProperty({ enum: ["ok", "empty"] })
  status!: "empty" | "ok";
}

export class MonthMealsResponseDto {
  @ApiProperty({
    maxItems: 31,
    minItems: 28,
    type: () => [MonthMealDayResponseDto],
  })
  items!: MonthMealDayResponseDto[];

  @ApiProperty({ example: "2026-07", pattern: "^\\d{4}-\\d{2}$", type: String })
  month!: string;

  @ApiProperty({ example: "2026-07-14", format: "date", type: String })
  server_today!: string;
}
