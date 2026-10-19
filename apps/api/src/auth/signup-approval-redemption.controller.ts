import { Body, Controller, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiProperty, ApiResponse, ApiTags } from "@nestjs/swagger";
import { IsIn, IsString, Matches } from "class-validator";
import { AllowUnverifiedEmail } from "./allow-unverified-email.decorator.js";
import { AuthenticatedCsrfGuard } from "./authenticated-csrf.guard.js";
import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "./authenticated-request.js";
import { SignupApprovalRedemptionService } from "./signup-approval-redemption.service.js";

export class RedeemSignupApprovalDto {
  @ApiProperty({ type: String, minLength: 6, maxLength: 6, pattern: "^[0-9]{6}$", writeOnly: true })
  @IsString()
  @Matches(/^[0-9]{6}$/u)
  approval_code!: string;
}

export class ConfirmSignupRoleDto {
  @ApiProperty({ enum: ["student", "teacher"], type: String })
  @IsIn(["student", "teacher"])
  role!: "student" | "teacher";
}

@ApiTags("auth")
@Controller("auth/signup-approval")
export class SignupApprovalRedemptionController {
  constructor(private readonly service: SignupApprovalRedemptionService) {}

  @Post("role")
  @HttpCode(200)
  @AllowUnverifiedEmail()
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "가입 유형이 누락된 본인 승인 대기 계정의 유형을 한 번 확인" })
  confirmRole(@Body() body: ConfirmSignupRoleDto, @Req() request: AuthenticatedFastifyRequest) {
    return this.service.confirmRole(getAuthenticatedSession(request).userId, body.role);
  }

  @Post("confirm")
  @HttpCode(200)
  @AllowUnverifiedEmail()
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "본인 계정의 이메일 인증 또는 이메일 인증 후 관리자 가입 승인" })
  @ApiResponse({
    status: 200,
    description:
      "번호 확인 완료. 교사 이메일 인증만 마친 경우 signup_approved=false이며 관리자 승인이 추가로 필요",
  })
  confirm(@Body() body: RedeemSignupApprovalDto, @Req() request: AuthenticatedFastifyRequest) {
    return this.service.redeem(
      getAuthenticatedSession(request).userId,
      body.approval_code,
      request.id,
    );
  }
}
