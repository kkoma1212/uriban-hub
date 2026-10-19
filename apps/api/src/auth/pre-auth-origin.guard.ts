import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { AppEnvironment } from "../config/environment.js";
import { OriginNotAllowedException } from "./auth.errors.js";
import type { AuthenticatedFastifyRequest } from "./authenticated-request.js";

@Injectable()
export class PreAuthOriginGuard implements CanActivate {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedFastifyRequest>();
    const expectedOrigin = new URL(this.config.get("PUBLIC_APP_ORIGIN", { infer: true })).origin;

    if (request.headers.origin !== expectedOrigin) {
      throw new OriginNotAllowedException();
    }

    return true;
  }
}
