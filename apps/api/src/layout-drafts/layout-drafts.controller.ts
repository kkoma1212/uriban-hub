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
import { SaveLayoutDraftDto } from "./layout-drafts.dto.js";
import { LayoutDraftInvalidException } from "./layout-drafts.errors.js";
import { LayoutDraftItemResponseDto } from "./layout-drafts.openapi.js";
import { LayoutDraftsService } from "./layout-drafts.service.js";
import {
  isLayoutDraftKind,
  LAYOUT_DRAFT_KINDS,
  type LayoutDraftItem,
  type LayoutDraftKind,
} from "./layout-drafts.types.js";

const KIND_PARAM = {
  name: "kind",
  schema: { enum: [...LAYOUT_DRAFT_KINDS], type: "string" },
} as const;

function parseKind(raw: string): LayoutDraftKind {
  if (!isLayoutDraftKind(raw)) {
    throw new LayoutDraftInvalidException("알 수 없는 임시저장 종류입니다.");
  }
  return raw;
}

/*
 * 임시저장에는 Idempotency-Key를 쓰지 않는다. 저장이 덮어쓰기 하나라 같은 요청이 두 번
 * 나가도 결과가 같고(멱등), 마법사가 값이 바뀔 때마다 부르므로 키를 붙이면 저장소가
 * 요청 수만큼 부풀기 때문이다. 선거에서 멱등성 저장이 무기명을 깨뜨릴 뻔했던 것과는
 * 다른 이유이지만, "관례라서 붙인다"를 하지 않는다는 점은 같다.
 */
@ApiTags("layout-drafts")
@Controller("layout-drafts")
export class LayoutDraftsController {
  constructor(private readonly layoutDraftsService: LayoutDraftsService) {}

  @Get(":kind")
  @UseGuards(AuthenticatedSessionGuard)
  @ApiOperation({ summary: "만들던 자리·모둠 이어받기" })
  @ApiParam(KIND_PARAM)
  @ApiOkResponse({ type: LayoutDraftItemResponseDto })
  get(
    @Param("kind") kind: string,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<LayoutDraftItem> {
    const session = getAuthenticatedSession(request);
    return this.layoutDraftsService.get({ actorUserId: session.userId, kind: parseKind(kind) });
  }

  @Put(":kind")
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "만들던 자리·모둠 임시저장" })
  @ApiParam(KIND_PARAM)
  @ApiBody({ type: SaveLayoutDraftDto })
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  @ApiOkResponse({ type: LayoutDraftItemResponseDto })
  save(
    @Param("kind") kind: string,
    @Body() body: SaveLayoutDraftDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<LayoutDraftItem> {
    const session = getAuthenticatedSession(request);
    return this.layoutDraftsService.save({
      actorUserId: session.userId,
      kind: parseKind(kind),
      payload: body.payload,
    });
  }

  @Delete(":kind")
  @HttpCode(204)
  @UseGuards(AuthenticatedCsrfGuard)
  @ApiOperation({ summary: "임시저장 비우기 (공개를 마쳤을 때)" })
  @ApiParam(KIND_PARAM)
  @ApiHeader({ name: "X-CSRF-Token", required: true, schema: { type: "string" } })
  clear(@Param("kind") kind: string, @Req() request: AuthenticatedFastifyRequest): Promise<void> {
    const session = getAuthenticatedSession(request);
    return this.layoutDraftsService.clear({ actorUserId: session.userId, kind: parseKind(kind) });
  }
}
