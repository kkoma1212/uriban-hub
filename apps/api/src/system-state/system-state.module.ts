import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Header,
  Inject,
  Injectable,
  Module,
  ServiceUnavailableException,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ApiOkResponse, ApiOperation, ApiProperty, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { publicSystemState, requiresMaintenanceCheck } from "./system-state.policy.js";

export class PublicSystemStateResponseDto {
  @ApiProperty({ description: "사용자 업무 변경 요청의 점검 차단 여부", type: Boolean })
  maintenance!: boolean;

  @ApiProperty({
    description: "활성 공지의 일반 텍스트. 비활성 공지는 null",
    type: String,
    nullable: true,
    maxLength: 500,
  })
  announcement!: string | null;
}

@Injectable()
export class PublicSystemStateService {
  constructor(@Inject(DATABASE) private readonly db: ClassHubDatabase) {}
  // Deliberately no shared cache: each write sees the latest committed setting across API processes.
  async read() {
    try {
      const rows = await this.db
        .selectFrom("admin_system_state")
        .select(["key", "value_json"])
        .where("key", "in", ["maintenance_mode", "announcement"])
        .execute();
      return publicSystemState(rows);
    } catch {
      throw new ServiceUnavailableException({
        code: "SYSTEM_STATE_UNAVAILABLE",
        message:
          "점검 상태를 확인하지 못했어요. 입력 내용은 그대로 두고 잠시 뒤 다시 시도해 주세요.",
      });
    }
  }
}

@Controller("public/system-state")
@ApiTags("공개 운영 상태")
export class PublicSystemStateController {
  constructor(private readonly service: PublicSystemStateService) {}
  @Get()
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "로그인 없이 공개 공지와 점검 상태 조회" })
  @ApiOkResponse({
    type: PublicSystemStateResponseDto,
    headers: { "Cache-Control": { schema: { type: "string", enum: ["no-store"] } } },
  })
  @ApiResponse({
    status: 503,
    description: "SYSTEM_STATE_UNAVAILABLE: 상태 조회 또는 검증 실패",
    content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
    headers: { "Cache-Control": { schema: { type: "string", enum: ["no-store"] } } },
  })
  read(): Promise<PublicSystemStateResponseDto> {
    return this.service.read();
  }
}

@Injectable()
export class MaintenanceMutationGuard implements CanActivate {
  constructor(private readonly service: PublicSystemStateService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (
      !requiresMaintenanceCheck(
        request.method,
        request.routeOptions.url ?? request.url,
        request.body,
      )
    )
      return true;
    const state = await this.service.read();
    if (state.maintenance)
      throw new ServiceUnavailableException({
        code: "MAINTENANCE_MODE",
        message:
          "서비스 점검 중이라 저장·변경을 잠시 멈췄어요. 입력 내용은 그대로 두고 점검이 끝난 뒤 다시 시도해 주세요.",
      });
    return true;
  }
}

@Module({
  controllers: [PublicSystemStateController],
  providers: [PublicSystemStateService, { provide: APP_GUARD, useClass: MaintenanceMutationGuard }],
})
export class PublicSystemStateModule {}
