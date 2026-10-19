import { applyDecorators } from "@nestjs/common";
import { ApiProperty, ApiResponse } from "@nestjs/swagger";

import type { InAppReminderResult } from "./in-app-reminders.types.js";

function reminderErrorSchema(
  codes: readonly string[],
  detailsProperties?: Record<string, { format?: string; pattern?: string; type: "string" }>,
) {
  return {
    properties: {
      error: {
        properties: {
          code: { enum: [...codes], type: "string" as const },
          ...(detailsProperties === undefined
            ? {}
            : {
                details: {
                  additionalProperties: false,
                  properties: detailsProperties,
                  type: "object" as const,
                },
              }),
          message: { type: "string" as const },
          request_id: { type: "string" as const },
        },
        required: ["code", "message", "request_id"],
        type: "object" as const,
      },
    },
    required: ["error"],
    type: "object" as const,
  };
}

export function ApiInAppReminderFailureResponses() {
  return applyDecorators(
    ApiResponse({
      description: "내용 버전 변경, 미해결 학생 없음 또는 같은 멱등 키의 다른 요청 본문",
      schema: reminderErrorSchema(
        ["CONTENT_REVISION_CHANGED", "REMINDER_NO_UNRESOLVED_RECIPIENTS", "IDEMPOTENCY_KEY_REUSED"],
        { current_revision: { pattern: "^[1-9][0-9]*$", type: "string" } },
      ),
      status: 409,
    }),
    ApiResponse({
      description: "학생별 24시간 업무 쿨다운 또는 교사 actor 기술 요청 제한",
      headers: {
        "Retry-After": {
          description: "다시 요청하기 전 대기할 초 단위 시간",
          schema: { minimum: 1, type: "integer" },
        },
      },
      schema: reminderErrorSchema(["REMINDER_COOLDOWN_ACTIVE", "RATE_LIMITED"], {
        next_available_at: { format: "date-time", type: "string" },
      }),
      status: 429,
    }),
    ApiResponse({
      description: "요청 제한 저장소 장애로 제품 상태 변경 전에 실패",
      schema: reminderErrorSchema(["RATE_LIMIT_SERVICE_UNAVAILABLE"]),
      status: 503,
    }),
  );
}

export class InAppReminderResponseDto implements InAppReminderResult {
  @ApiProperty({ format: "uuid", type: String })
  batch_id!: string;

  @ApiProperty({ minimum: 0, type: Number })
  cooldown_suppressed_count!: number;

  @ApiProperty({ example: "2026-07-24T07:00:00.000Z", format: "date-time", type: String })
  created_at!: string;

  @ApiProperty({ minimum: 0, type: Number })
  created_count!: number;

  @ApiProperty({ minimum: 0, type: Number })
  current_unresolved_count!: number;

  @ApiProperty({
    example: "2026-07-25T07:00:00.000Z",
    format: "date-time",
    nullable: true,
    type: String,
  })
  next_available_at!: string | null;
}
