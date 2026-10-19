import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";

import { AuthenticatedCsrfGuard } from "../auth/authenticated-csrf.guard.js";
import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import { SaveLayoutTemplateDto } from "./layout-templates.dto.js";
import {
  LayoutTemplateItemResponseDto,
  LayoutTemplateListResponseDto,
} from "./layout-templates.openapi.js";
import { LayoutTemplatesService } from "./layout-templates.service.js";
import type { LayoutTemplateItem, LayoutTemplateListResult } from "./layout-templates.types.js";

/*
 * 임시저장과 마찬가지로 Idempotency-Key 도 If-Match 도 쓰지 않는다. 저장은 **이름 기준
 * 덮어쓰기**라 같은 요청이 두 번 나가도 결과가 같고(멱등), 이 자료에는 여러 사람이
 * 동시에 손대는 상황이 없다 — 한 교사의 개인 목록이기 때문이다. "관례라서 붙인다"를
 * 하지 않는다.
 */
@ApiTags("layout-templates")
@Controller("layout-templates")
export class LayoutTemplatesController {
  constructor(private readonly layoutTemplatesService: LayoutTemplatesService) {}

  @Get()
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "저장해 둔 교실 배치 목록" })
  @ApiOkResponse({ type: LayoutTemplateListResponseDto })
  list(@Req() request: AuthenticatedFastifyRequest): Promise<LayoutTemplateListResult> {
    const session = getAuthenticatedSession(request);
    return this.layoutTemplatesService.list({ actorUserId: session.userId });
  }

  @Put()
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "교실 배치를 이름 붙여 저장 (같은 이름이면 덮어쓴다)" })
  @ApiBody({ type: SaveLayoutTemplateDto })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiOkResponse({ type: LayoutTemplateItemResponseDto })
  save(
    @Body() body: SaveLayoutTemplateDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<LayoutTemplateItem> {
    const session = getAuthenticatedSession(request);
    return this.layoutTemplatesService.save({
      actorUserId: session.userId,
      name: body.name,
      payload: body.payload,
    });
  }

  @Delete(":templateId")
  @HttpCode(204)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "저장해 둔 교실 배치 지우기" })
  @ApiParam({ name: "templateId", schema: { pattern: "^[1-9][0-9]*$", type: "string" } })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiNoContentResponse()
  delete(
    @Param("templateId") templateId: string,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<void> {
    const session = getAuthenticatedSession(request);
    return this.layoutTemplatesService.delete({ actorUserId: session.userId, templateId });
  }
}
