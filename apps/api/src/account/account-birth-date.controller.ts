import { Body, Controller, Get, HttpCode, Patch, Req, UseGuards } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiProperty, ApiResponse, ApiTags } from "@nestjs/swagger";
import { IsBoolean, IsOptional, IsString, Matches } from "class-validator";

import { AuthenticatedCsrfGuard } from "../auth/authenticated-csrf.guard.js";
import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import { AccountBirthDateService } from "./account-birth-date.service.js";

export class AccountBirthDateResponseDto {
  @ApiProperty({ description: "생년월일 칸이 설치된 환경인지", type: Boolean })
  available!: boolean;
  @ApiProperty({ format: "date", nullable: true, type: String })
  birth_date!: string | null;
  @ApiProperty({ description: "생일 당일 우리 반 홈에 알릴지", type: Boolean })
  birthday_shared!: boolean;
}

export class UpdateAccountBirthDateRequestDto {
  @ApiProperty({
    required: false,
    format: "date",
    pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
    type: String,
    description: "비어 있을 때 한 번만 입력할 수 있습니다.",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u)
  birth_date?: string;

  @ApiProperty({ required: false, type: Boolean })
  @IsOptional()
  @IsBoolean()
  birthday_shared?: boolean;
}

@ApiTags("account")
@Controller("account/birth-date")
export class AccountBirthDateController {
  constructor(private readonly birthDates: AccountBirthDateService) {}

  @Get()
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "내 생년월일과 생일 알림 설정" })
  @ApiResponse({ status: 200, type: AccountBirthDateResponseDto })
  @ApiResponse({ status: 401, description: "현재 세션 또는 계정이 유효하지 않음" })
  read(@Req() request: AuthenticatedFastifyRequest): Promise<AccountBirthDateResponseDto> {
    return this.birthDates.read(getAuthenticatedSession(request).userId);
  }

  @Patch()
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "비어 있는 생년월일 입력 · 생일 알림 켜고 끄기" })
  @ApiBody({ type: UpdateAccountBirthDateRequestDto })
  @ApiResponse({ status: 200, type: AccountBirthDateResponseDto })
  @ApiResponse({ status: 400, description: "생년월일 형식 오류 또는 생년월일 없이 생일 알림" })
  @ApiResponse({ status: 401, description: "현재 세션 또는 계정이 유효하지 않음" })
  @ApiResponse({ status: 403, description: "Origin 또는 CSRF 검증 실패" })
  @ApiResponse({ status: 409, description: "이미 입력함 · 가입 나이 경로와 다름 · 설치 안 됨" })
  update(
    @Body() body: UpdateAccountBirthDateRequestDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<AccountBirthDateResponseDto> {
    return this.birthDates.update(getAuthenticatedSession(request).userId, body);
  }
}
