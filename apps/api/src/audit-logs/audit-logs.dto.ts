import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsIn, IsString, ValidateIf } from "class-validator";

import {
  AUDIT_LOG_DAY_OPTIONS,
  CLASS_AUDIT_ACTIONS,
  type AuditLogDays,
  type ClassAuditAction,
} from "./audit-logs.types.js";

// 목록에서 파생시킨다. 여기에 따로 적어두면 선택지를 늘릴 때 검증만 뒤처져
// 새 기간이 400으로 막힌다(T-HUB-13에서 실제로 걸렸다). "090" 같은 비정규 표기는
// 이 정규식에 안 걸려 문자열로 남고 IsIn에서 거부된다.
const EXACT_DAY_PATTERN = new RegExp(`^(${AUDIT_LOG_DAY_OPTIONS.join("|")})$`, "u");

const exactDays = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" && EXACT_DAY_PATTERN.test(value) ? Number(value) : value;

export class ListAuditLogsQueryDto {
  @ApiPropertyOptional({ enum: CLASS_AUDIT_ACTIONS })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(CLASS_AUDIT_ACTIONS)
  action?: ClassAuditAction;

  @ApiPropertyOptional({
    description: "이전 응답의 current class-bound opaque Base64URL 커서",
    type: String,
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ default: 90, enum: AUDIT_LOG_DAY_OPTIONS, type: Number })
  @Transform(exactDays)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(AUDIT_LOG_DAY_OPTIONS)
  days?: AuditLogDays;
}
