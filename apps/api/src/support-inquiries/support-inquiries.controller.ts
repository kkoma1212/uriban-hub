import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { AuthenticatedCsrfGuard } from "../auth/authenticated-csrf.guard.js";
import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import { CreateSupportInquiryDto } from "./support-inquiries.dto.js";
import { SupportInquiriesService } from "./support-inquiries.service.js";

@ApiTags("support-inquiries")
@Controller("support-inquiries")
export class SupportInquiriesController {
  constructor(private readonly service: SupportInquiriesService) {}

  @Get()
  @UseGuards(AuthenticatedSessionGuard)
  list(@Req() request: AuthenticatedFastifyRequest) {
    return this.service.list(getAuthenticatedSession(request).userId);
  }

  @Post()
  @UseGuards(AuthenticatedCsrfGuard)
  create(@Body() body: CreateSupportInquiryDto, @Req() request: AuthenticatedFastifyRequest) {
    return this.service.create(getAuthenticatedSession(request).userId, body.subject, body.body);
  }
}
