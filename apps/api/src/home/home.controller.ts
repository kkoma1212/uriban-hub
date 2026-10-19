import { Controller, Get, HttpException, Req, UseGuards } from "@nestjs/common";
import { ApiExtraModels, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import {
  AttendanceCountsResponseDto,
  AttendanceNotificationItemResponseDto,
} from "../attendance-notifications/attendance-notifications.openapi.js";
import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import { NoticeConfirmationCountsResponseDto } from "../notices/notices.openapi.js";
import { SupplyCheckCountsResponseDto } from "../supplies/supplies.openapi.js";
import { HomeUnavailableException } from "./home.errors.js";
import {
  HomeBirthdayResponseDto,
  HomeMealMenuItemResponseDto,
  HomeMealResponseDto,
  HomeNoticeResponseDto,
  HomePollResponseDto,
  HomeReminderResponseDto,
  HomeResponseDto,
  HomeScheduleResponseDto,
  HomeSupplyResponseDto,
  TeacherHomeNoticeFollowupResponseDto,
  TeacherHomeSupplyFollowupResponseDto,
} from "./home.openapi.js";
import { HomeService } from "./home.service.js";
import type { HomeResult } from "./home.types.js";

@ApiTags("home")
@ApiExtraModels(
  AttendanceCountsResponseDto,
  AttendanceNotificationItemResponseDto,
  HomeBirthdayResponseDto,
  HomeMealMenuItemResponseDto,
  HomeMealResponseDto,
  HomeNoticeResponseDto,
  HomePollResponseDto,
  HomeReminderResponseDto,
  HomeScheduleResponseDto,
  HomeSupplyResponseDto,
  NoticeConfirmationCountsResponseDto,
  SupplyCheckCountsResponseDto,
  TeacherHomeNoticeFollowupResponseDto,
  TeacherHomeSupplyFollowupResponseDto,
)
@Controller("home")
export class HomeController {
  constructor(private readonly homeService: HomeService) {}

  @Get()
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "학생·교사 현재 반 홈 카드 조합 조회" })
  @ApiOkResponse({
    description: "카드별 ok, empty 또는 error 응답",
    type: HomeResponseDto,
  })
  async getHome(@Req() request: AuthenticatedFastifyRequest): Promise<HomeResult> {
    try {
      const session = getAuthenticatedSession(request);
      return await this.homeService.getForUser(session.userId);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HomeUnavailableException();
    }
  }
}
