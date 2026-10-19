import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Optional,
} from "@nestjs/common";
import type { ExceptionFilter } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { PasswordWorkCapacityError } from "@classhub/db";
import { ApiMariaDbDatabaseError } from "../../database/mariadb-database.js";

import {
  createSecurityAuditHttpContext,
  isLoginFailureAuditCandidate,
  readLoginEmail,
  SecurityAuditHttpProducer,
} from "../../security-audit/security-audit-http.producer.js";
import { ERROR_CODES } from "./error-codes.js";
import type { ErrorEnvelope } from "./error-envelope.js";
import { recordHttpRequestFailureForLog } from "../logging/http-observability.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function defaultCode(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return ERROR_CODES.VALIDATION_FAILED;
    case HttpStatus.UNAUTHORIZED:
      return ERROR_CODES.UNAUTHENTICATED;
    case HttpStatus.FORBIDDEN:
      return ERROR_CODES.ROLE_INSUFFICIENT;
    case HttpStatus.NOT_FOUND:
      return ERROR_CODES.NOT_FOUND;
    case HttpStatus.CONFLICT:
      return ERROR_CODES.CONFLICT;
    case HttpStatus.LOCKED:
      return ERROR_CODES.CLASS_SUSPENDED;
    case HttpStatus.PRECONDITION_REQUIRED:
      return ERROR_CODES.IF_MATCH_REQUIRED;
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return ERROR_CODES.PAYLOAD_TOO_LARGE;
    case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
      return ERROR_CODES.UNSUPPORTED_MEDIA_TYPE;
    case HttpStatus.TOO_MANY_REQUESTS:
      return ERROR_CODES.RATE_LIMITED;
    default:
      return ERROR_CODES.INTERNAL_ERROR;
  }
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);
  constructor(
    @Optional()
    @Inject(SecurityAuditHttpProducer)
    private readonly securityAuditProducer?: SecurityAuditHttpProducer,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest>();
    const reply = context.getResponse<FastifyReply>();
    const overloaded =
      exception instanceof PasswordWorkCapacityError ||
      (exception instanceof ApiMariaDbDatabaseError &&
        ["connection_queue_full", "connection_timeout", "query_timeout"].includes(
          exception.reason,
        ));
    const status = overloaded
      ? 503
      : exception instanceof HttpException
        ? exception.getStatus()
        : 500;
    const response = overloaded
      ? { code: ERROR_CODES.SERVICE_UNAVAILABLE, retry_after_seconds: 2 }
      : exception instanceof HttpException
        ? exception.getResponse()
        : null;

    const structured = isRecord(response) ? response : null;
    const hasStructuredCode = typeof structured?.code === "string";
    const code =
      status === HttpStatus.UNSUPPORTED_MEDIA_TYPE
        ? ERROR_CODES.UNSUPPORTED_MEDIA_TYPE
        : hasStructuredCode
          ? (structured.code as string)
          : defaultCode(status);
    const auditCode =
      status === HttpStatus.TOO_MANY_REQUESTS &&
      !(hasStructuredCode && code === ERROR_CODES.ACCOUNT_LOCKED)
        ? ERROR_CODES.RATE_LIMITED
        : code;

    recordHttpRequestFailureForLog(request, code);

    if (
      (hasStructuredCode || status === HttpStatus.TOO_MANY_REQUESTS) &&
      this.securityAuditProducer !== undefined
    ) {
      try {
        const auditContext = createSecurityAuditHttpContext(request);
        const emailIdentity = isLoginFailureAuditCandidate(auditContext, auditCode)
          ? this.securityAuditProducer.createEmailIdentity(readLoginEmail(request))
          : null;
        void this.securityAuditProducer
          .recordFailure(auditContext, auditCode, emailIdentity)
          .catch(() => undefined);
      } catch {
        // Audit enrichment is deliberately isolated from the original HTTP contract.
      }
    }

    const safeMessage =
      status >= 500
        ? "요청을 처리하지 못했습니다."
        : status === HttpStatus.BAD_REQUEST && !hasStructuredCode
          ? "요청 형식을 확인해 주세요."
          : status === HttpStatus.PAYLOAD_TOO_LARGE && !hasStructuredCode
            ? "요청 내용이 너무 큽니다. 입력 내용을 줄여 다시 시도해 주세요."
            : status === HttpStatus.UNSUPPORTED_MEDIA_TYPE
              ? "요청 형식을 처리할 수 없어요. 화면을 새로고침한 뒤 다시 시도해 주세요."
              : // 없는 경로(꺼진 기능 포함)의 라우터 기본 문구 'Cannot GET /api/...'가 화면에 그대로
                // 보이지 않게 한다(총검수 B4-03). 서비스가 던진 404 문구는 그대로 둔다.
                status === HttpStatus.NOT_FOUND &&
                  !hasStructuredCode &&
                  typeof structured?.message === "string" &&
                  /^Cannot [A-Z]+ \//u.test(structured.message)
                ? "찾는 화면이나 기능이 없어요."
                : typeof structured?.message === "string"
                  ? structured.message
                  : typeof response === "string"
                    ? response
                    : "요청을 처리할 수 없습니다.";

    if (status >= 500) {
      this.logger.error({
        exception_name: exception instanceof Error ? exception.name : typeof exception,
        failure_code: code,
        request_id: request.id,
      });
    }

    const body: ErrorEnvelope = {
      error: {
        code,
        message: safeMessage,
        request_id: request.id,
      },
    };

    if (structured?.details !== undefined && isRecord(structured.details)) {
      body.error.details = structured.details;
    }

    if (
      (status === HttpStatus.TOO_MANY_REQUESTS || status === HttpStatus.SERVICE_UNAVAILABLE) &&
      typeof structured?.retry_after_seconds === "number"
    ) {
      const retryAfter = Math.max(1, Math.ceil(structured.retry_after_seconds));
      void reply.header("Retry-After", String(retryAfter));
      body.error.details = {
        ...body.error.details,
        retry_after_seconds: retryAfter,
        retry_at: new Date(Date.now() + retryAfter * 1000).toISOString(),
      };
    }

    void reply.status(status).send(body);
  }
}
