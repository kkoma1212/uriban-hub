import { Controller, Get, Param, Query, Res } from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPropertyOptional,
  ApiTags,
} from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";
import { CodePointLength, IsPlainText } from "../common/validation/text-validation.js";
import type { FastifyReply } from "fastify";
import { ADMIN_LEGAL_DOCUMENT_TYPES } from "../admin-management/admin-management.dto.js";
import { LegalDocumentsService } from "./legal-documents.service.js";
import { LegalConsentBundleDto } from "./legal-consent.dto.js";

export class LegalDocumentsQueryDto {
  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 80 })
  @IsOptional()
  @IsString()
  @CodePointLength(1, 80)
  @IsPlainText()
  policy_version?: string;
}

@ApiTags("legal")
@Controller("legal/documents")
export class LegalDocumentsController {
  constructor(private readonly documents: LegalDocumentsService) {}

  @Get("consent-bundle")
  @ApiOperation({ summary: "가입과 보호자 동의에 사용할 네 문서의 현재 불변 버전 조회" })
  @ApiOkResponse({ type: LegalConsentBundleDto })
  consentBundle(@Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header("Cache-Control", "no-store");
    return this.documents.consentBundle();
  }

  @Get(":documentType")
  @ApiParam({ name: "documentType", enum: ADMIN_LEGAL_DOCUMENT_TYPES })
  @ApiOperation({ summary: "로그인 없이 시행 중인 법률 문서와 이전 게시본 조회" })
  @ApiOkResponse({ description: "게시본과 이전 버전 목록. 게시된 문서가 없으면 version은 null." })
  read(
    @Param("documentType") documentType: string,
    @Query() query: LegalDocumentsQueryDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    void reply.header("Cache-Control", "no-store");
    return this.documents.read(documentType, query.policy_version);
  }
}
