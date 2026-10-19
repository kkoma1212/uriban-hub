import {
  Inject,
  Injectable,
  NotFoundException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { AppEnvironment } from "../config/environment.js";

@Injectable()
export class LocalTestAdminEnabledGuard implements CanActivate {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  canActivate(_context: ExecutionContext): boolean {
    if (
      this.config.get("NODE_ENV", { infer: true }) !== "development" ||
      !this.config.get("LOCAL_TEST_ADMIN_ENABLED", { infer: true })
    ) {
      throw new NotFoundException();
    }
    return true;
  }
}
