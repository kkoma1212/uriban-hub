import {
  Inject,
  Injectable,
  NotFoundException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { ERROR_CODES } from "../common/errors/error-codes.js";
import type { AppEnvironment } from "../config/environment.js";

@Injectable()
export class PasswordResetEnabledGuard implements CanActivate {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  canActivate(_context: ExecutionContext): boolean {
    if (!this.config.get("PASSWORD_RESET_ENABLED", { infer: true })) {
      throw new NotFoundException({
        code: ERROR_CODES.PASSWORD_RESET_UNAVAILABLE,
        message: "현재 비밀번호 찾기를 이용할 수 없어요.",
      });
    }
    return true;
  }
}
