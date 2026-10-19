import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { readCookie } from "../auth/session-cookie.js";
import {
  clearLocalAdminCookies,
  createLocalAdminCookies,
  LOCAL_ADMIN_SESSION_COOKIE,
} from "./local-test-admin.cookies.js";
import {
  CreateLocalTestAccountDto,
  DeleteLocalTestAccountDto,
  LocalAdminLoginDto,
} from "./local-test-admin.dto.js";
import { LocalTestAdminService } from "./local-test-admin.service.js";
import { LocalTestAdminEnabledGuard } from "./local-test-admin-enabled.guard.js";
import type { DeletedLocalTestAccount, LocalTestAccount } from "./local-test-admin.types.js";

@Controller("local-test-admin")
@UseGuards(LocalTestAdminEnabledGuard)
export class LocalTestAdminController {
  constructor(private readonly service: LocalTestAdminService) {}

  @Post("login")
  @HttpCode(200)
  async login(
    @Body() body: LocalAdminLoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ logged_in: true }> {
    this.service.assertOrigin(request.headers.origin);
    const result = await this.service.login(body.username, body.password);
    void reply.header(
      "Set-Cookie",
      createLocalAdminCookies(result.sessionToken, result.csrfToken, result.expiresAt),
    );
    return { logged_in: true };
  }

  @Post("logout")
  @HttpCode(200)
  logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): { logged_out: true } {
    this.service.assertOrigin(request.headers.origin);
    this.service.logout(readCookie(request.headers.cookie, LOCAL_ADMIN_SESSION_COOKIE));
    void reply.header("Set-Cookie", clearLocalAdminCookies());
    return { logged_out: true };
  }

  @Get("accounts")
  async listAccounts(@Req() request: FastifyRequest): Promise<{ accounts: LocalTestAccount[] }> {
    await this.service.requireSession(
      readCookie(request.headers.cookie, LOCAL_ADMIN_SESSION_COOKIE),
    );
    return { accounts: await this.service.listAccounts() };
  }

  @Post("accounts")
  async createAccount(
    @Body() body: CreateLocalTestAccountDto,
    @Req() request: FastifyRequest,
  ): Promise<LocalTestAccount> {
    this.service.assertOrigin(request.headers.origin);
    const csrfHeader = request.headers["x-local-admin-csrf"];
    await this.service.requireMutation(
      readCookie(request.headers.cookie, LOCAL_ADMIN_SESSION_COOKIE),
      typeof csrfHeader === "string" ? csrfHeader : undefined,
    );
    return this.service.createAccount(body, request.ip);
  }

  @Delete("accounts/:id")
  async deleteAccount(
    @Param("id") id: string,
    @Body() body: DeleteLocalTestAccountDto,
    @Req() request: FastifyRequest,
  ): Promise<DeletedLocalTestAccount> {
    this.service.assertOrigin(request.headers.origin);
    const csrfHeader = request.headers["x-local-admin-csrf"];
    await this.service.requireMutation(
      readCookie(request.headers.cookie, LOCAL_ADMIN_SESSION_COOKIE),
      typeof csrfHeader === "string" ? csrfHeader : undefined,
    );
    return this.service.deleteAccount(id, body.email);
  }
}
