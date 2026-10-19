import { ApiProperty } from "@nestjs/swagger";

export class AuditLogActorResponseDto {
  @ApiProperty({ type: String })
  display_name!: string;

  @ApiProperty({ enum: ["teacher", "student", "operator"] })
  role!: "operator" | "student" | "teacher";
}

export class AuditLogTargetResponseDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ additionalProperties: true, nullable: true, type: Object })
  snapshot!: Record<string, boolean | number | string | null> | null;

  @ApiProperty({ type: String })
  type!: string;
}

export class AuditLogItemResponseDto {
  @ApiProperty({ type: String })
  action!: string;

  @ApiProperty({ type: AuditLogActorResponseDto })
  actor!: AuditLogActorResponseDto;

  @ApiProperty({ additionalProperties: true, nullable: true, type: Object })
  after!: Record<string, boolean | number | string | null> | null;

  @ApiProperty({ additionalProperties: true, nullable: true, type: Object })
  before!: Record<string, boolean | number | string | null> | null;

  @ApiProperty({ example: "2026-07-18T03:04:05.123456Z", format: "date-time", type: String })
  created_at!: string;

  @ApiProperty({ maxLength: 300, nullable: true, type: String })
  reason!: string | null;

  @ApiProperty({ type: AuditLogTargetResponseDto })
  target!: AuditLogTargetResponseDto;
}

export class AuditLogListResponseDto {
  @ApiProperty({ type: () => [AuditLogItemResponseDto] })
  items!: AuditLogItemResponseDto[];

  @ApiProperty({ nullable: true, type: String })
  next_cursor!: string | null;
}
