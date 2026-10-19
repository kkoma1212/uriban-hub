import { Module, RequestMethod } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import type { Options as PinoHttpOptions } from "pino-http";

import { createHttpRequestCompletionLog, httpRequestLogLevel } from "./http-observability.js";
import { serializeRequestForLog } from "./request-log-url.js";
import { readServiceIdentity } from "./service-identity.js";

export function createPinoHttpOptions(level = process.env.LOG_LEVEL ?? "info"): PinoHttpOptions {
  return {
    /*
     * pid·hostname 같은 pino 기본 필드는 계속 내보내지 않는다(그래서 null이었다).
     * 대신 최소 log 계약이 요구하는 신원 필드만 골라 모든 줄에 붙인다.
     */
    base: readServiceIdentity("api"),
    level,
    redact: {
      censor: "[REDACTED]",
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.x-csrf-token",
        "req.headers.x-local-admin-csrf",
        "req.headers.x-admin-csrf",
        "req.body.email",
        "req.body.password",
        "req.body.current_password",
        "req.body.new_password",
        "req.body.totp_code",
        "req.body.token",
        "res.headers.set-cookie",
      ],
    },
    serializers: {
      req: serializeRequestForLog,
    },
    quietReqLogger: true,
    quietResLogger: true,
    customAttributeKeys: {
      reqId: "request_id",
    },
    customLogLevel: httpRequestLogLevel,
    customSuccessObject: (request, response, value) =>
      createHttpRequestCompletionLog(request, response, value),
    customErrorObject: (request, response, _error, value) =>
      createHttpRequestCompletionLog(request, response, value),
    customSuccessMessage: () => "HTTP request completed.",
    customErrorMessage: () => "HTTP request failed.",
  };
}

@Module({
  imports: [
    LoggerModule.forRoot({
      forRoutes: [{ path: "{*path}", method: RequestMethod.ALL }],
      pinoHttp: createPinoHttpOptions(),
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
