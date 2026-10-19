import {
  type BeforeApplicationShutdown,
  Controller,
  Get,
  HttpStatus,
  Inject,
  Optional,
  Res,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ApiOkResponse,
  ApiProperty,
  ApiServiceUnavailableResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { FastifyReply } from "fastify";

import { AUTH_RATE_LIMITER } from "../auth/auth.tokens.js";
import type { RedisRateLimiter } from "../common/rate-limit/redis-rate-limiter.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import type { AppEnvironment } from "../config/environment.js";
import { probeApiMariaDbReadiness } from "../database/mariadb-database.js";
import { probeDatabaseReadiness, ReadinessProbeCoordinator } from "./readiness-probe.js";

class HealthResponseDto {
  @ApiProperty({ enum: ["ok"], example: "ok" })
  status!: "ok";
}

class ReadinessResponseDto {
  @ApiProperty({ enum: ["ready", "not_ready"], example: "ready" })
  status!: "not_ready" | "ready";
}

type ReadinessResponse = { status: "not_ready" } | { status: "ready" };

@ApiTags("health")
@Controller()
export class HealthController implements BeforeApplicationShutdown {
  private readonly readiness: ReadinessProbeCoordinator;
  private stopping = false;

  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Inject(AUTH_RATE_LIMITER) rateLimiter: RedisRateLimiter,
    @Optional() private readonly config?: ConfigService<AppEnvironment, true>,
  ) {
    this.readiness = new ReadinessProbeCoordinator({
      database: () => this.probeDatabase(),
      redis: () => rateLimiter.ensureAvailable(),
    });
  }

  beforeApplicationShutdown(): void {
    this.stopping = true;
  }

  @Get("healthz")
  @ApiOkResponse({ description: "프로세스 liveness", type: HealthResponseDto })
  getHealth(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("readyz")
  @ApiOkResponse({
    description: "데이터베이스와 Redis가 요청을 처리할 준비가 됨",
    type: ReadinessResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: "하나 이상의 필수 dependency가 준비되지 않음",
    type: ReadinessResponseDto,
  })
  async getReadiness(@Res({ passthrough: true }) reply: FastifyReply): Promise<ReadinessResponse> {
    const ready = !this.stopping && (await this.readiness.isReady());

    if (!ready || this.stopping) {
      void reply.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: "not_ready" };
    }

    return { status: "ready" };
  }

  private probeDatabase(): Promise<void> {
    if (this.config?.get("DATABASE_ENGINE", { infer: true }) === "mariadb") {
      return probeApiMariaDbReadiness(this.database);
    }
    return probeDatabaseReadiness(this.database);
  }
}
