import { Body, Controller, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";

import { AccountRecoveryRequestDto, AccountRecoveryResponseDto } from "./account-recovery.dto.js";
import { AccountRecoveryService } from "./account-recovery.service.js";
import { PreAuthOriginGuard } from "./pre-auth-origin.guard.js";
import { publicAccountResponse } from "./public-account-response.js";
import {
  AccountRequestAdmissionGuard,
  AccountRequestBudget,
} from "./account-request-admission.guard.js";

@ApiTags("auth")
@Controller("auth/account-recovery-requests")
export class AccountRecoveryController {
  constructor(private readonly service: AccountRecoveryService) {}

  @Post()
  @HttpCode(202)
  @UseGuards(PreAuthOriginGuard, AccountRequestAdmissionGuard)
  @AccountRequestBudget("account-request")
  @ApiOperation({ summary: "이메일로 가입 아이디 안내 요청" })
  @ApiBody({ type: AccountRecoveryRequestDto })
  @ApiResponse({
    status: 202,
    description: "계정 존재와 메일 전달 여부를 노출하지 않는 요청 접수",
    type: AccountRecoveryResponseDto,
  })
  request(@Body() body: AccountRecoveryRequestDto, @Req() request: FastifyRequest) {
    return publicAccountResponse(() => this.service.requestAccount(body.email, request.ip));
  }
}
