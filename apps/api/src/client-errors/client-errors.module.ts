import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { AuthModule } from "../auth/auth.module.js";
import type { AppEnvironment } from "../config/environment.js";
import { ClientErrorsController } from "./client-errors.controller.js";
import { RedisClientErrorBuckets } from "./client-errors.redis.js";
import { CLIENT_ERROR_BUCKETS, ClientErrorStore } from "./client-errors.store.js";

/** 관리자 운영 화면도 같은 보관소를 읽는다(모듈은 한 번만 만들어진다). */
@Module({
  imports: [AuthModule],
  controllers: [ClientErrorsController],
  providers: [
    {
      provide: CLIENT_ERROR_BUCKETS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnvironment, true>) =>
        new RedisClientErrorBuckets(config.get("REDIS_URL", { infer: true })),
    },
    ClientErrorStore,
  ],
  exports: [ClientErrorStore],
})
export class ClientErrorsModule {}
