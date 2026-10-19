import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import { MonthMealsQueryDto } from "./meals.dto.js";
import {
  MonthMealsResponseDto,
  TodayMealResponseDto,
  WeekMealsResponseDto,
} from "./meals.openapi.js";
import { MealsService } from "./meals.service.js";
import type { MonthMealsResult, TodayMealResult, WeekMealsResult } from "./meals.types.js";

@ApiTags("meals")
@Controller("meals")
export class MealsController {
  constructor(private readonly mealsService: MealsService) {}

  @Get("today")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "현재 반 학교의 오늘 중식 조회" })
  @ApiOkResponse({ type: TodayMealResponseDto })
  today(@Req() request: AuthenticatedFastifyRequest): Promise<TodayMealResult> {
    return this.mealsService.today(getAuthenticatedSession(request).userId);
  }

  @Get("week")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "현재 반 학교의 이번 주 월~금 중식 조회" })
  @ApiOkResponse({ type: WeekMealsResponseDto })
  week(@Req() request: AuthenticatedFastifyRequest): Promise<WeekMealsResult> {
    return this.mealsService.week(getAuthenticatedSession(request).userId);
  }

  @Get("month")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "현재 반 학교의 지정 월 중식 조회" })
  @ApiOkResponse({ type: MonthMealsResponseDto })
  month(
    @Req() request: AuthenticatedFastifyRequest,
    @Query() query: MonthMealsQueryDto,
  ): Promise<MonthMealsResult> {
    return this.mealsService.month(getAuthenticatedSession(request).userId, query.month);
  }
}
