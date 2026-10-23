import { Controller, Get, Param, Req, Res, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from "@nestjs/swagger";
import type { FastifyReply } from "fastify";

import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import { kstDate } from "../common/date/kst-date.js";
import { ClassRecordsService } from "./class-records.service.js";

function sendCsv(reply: FastifyReply, csv: string): void {
  const filename = `반-기록-${kstDate(new Date())}.csv`;
  void reply
    .header(
      "Content-Disposition",
      `attachment; filename="class-records.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    )
    .type("text/csv; charset=utf-8")
    .send(csv);
}

/** 반 기록 내려받기 — 읽기 전용(GET만), 담임만(역할은 서비스에서 막는다). */
@ApiTags("class-records")
@Controller()
export class ClassRecordsController {
  constructor(private readonly records: ClassRecordsService) {}

  @Get("classes/current/records.csv")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "현재 반에서 선생님이 쓴 공지·준비물·숙제·일정·투표 CSV(담임만)" })
  @ApiProduces("text/csv")
  @ApiOkResponse({ description: "UTF-8 BOM CSV", schema: { type: "string" } })
  async currentClass(
    @Req() request: AuthenticatedFastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = getAuthenticatedSession(request);
    sendCsv(reply, await this.records.currentClassCsv(session.userId));
  }

  @Get("past-classes/:classId/records.csv")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "지난 반(종료 후 365일 이내)의 선생님이 쓴 글 CSV(그 반 담임만)" })
  @ApiProduces("text/csv")
  @ApiOkResponse({ description: "UTF-8 BOM CSV", schema: { type: "string" } })
  async pastClass(
    @Param("classId") classId: string,
    @Req() request: AuthenticatedFastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = getAuthenticatedSession(request);
    sendCsv(reply, await this.records.pastClassCsv(session.userId, classId));
  }
}
