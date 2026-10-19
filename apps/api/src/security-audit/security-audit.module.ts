import { Inject, Injectable, Logger, Module, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { AppEnvironment } from "../config/environment.js";
import { SecurityAuditHttpProducer } from "./security-audit-http.producer.js";
import { createRedisSecurityAuditPublisher } from "./security-audit.publisher.js";
import { SECURITY_AUDIT_PUBLISHER } from "./security-audit.tokens.js";
import type {
  SecurityAuditFallbackLogger,
  SecurityAuditPublisher,
} from "./security-audit.types.js";

@Injectable()
class NestSecurityAuditFallbackLogger implements SecurityAuditFallbackLogger {
  private readonly logger = new Logger("SecurityAuditPublisher");

  error(entry: Parameters<SecurityAuditFallbackLogger["error"]>[0]): void {
    this.logger.error(entry);
  }
}

@Injectable()
class SecurityAuditPublisherLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(SECURITY_AUDIT_PUBLISHER) private readonly publisher: SecurityAuditPublisher,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.publisher.close();
  }
}

@Module({
  providers: [
    NestSecurityAuditFallbackLogger,
    {
      provide: SECURITY_AUDIT_PUBLISHER,
      inject: [ConfigService, NestSecurityAuditFallbackLogger],
      useFactory: (
        config: ConfigService<AppEnvironment, true>,
        fallbackLogger: SecurityAuditFallbackLogger,
      ): SecurityAuditPublisher =>
        createRedisSecurityAuditPublisher(config.get("REDIS_URL", { infer: true }), fallbackLogger),
    },
    SecurityAuditHttpProducer,
    SecurityAuditPublisherLifecycle,
  ],
  exports: [SecurityAuditHttpProducer, SECURITY_AUDIT_PUBLISHER],
})
export class SecurityAuditModule {}
