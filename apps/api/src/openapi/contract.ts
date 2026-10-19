import type { OpenAPIObject } from "@nestjs/swagger";

import { SESSION_COOKIE_NAME } from "../auth/session-cookie.js";
import {
  ADMIN_CHALLENGE_COOKIE_NAME,
  ADMIN_SESSION_COOKIE_NAME,
} from "../admin-auth/admin-auth.cookies.js";

type OperationObject = NonNullable<OpenAPIObject["paths"][string]["get"]>;
type OperationParameter = NonNullable<OperationObject["parameters"]>[number];
type InlineOperationParameter = Exclude<OperationParameter, { $ref: string }>;

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const SESSION_SECURITY_SCHEME = "classhubSession";
const ERROR_ENVELOPE_SCHEMA = "ErrorEnvelope";

const PUBLIC_OPERATION_IDS = new Set([
  "PublicSystemStateController_read",
  "AuthController_confirmEmail",
  "AuthController_confirmGuardianConsent",
  "AuthController_getGuardianConsentStatus",
  "AuthController_login",
  "AuthController_requestGuardianConsent",
  "AuthController_signUp",
  "HealthController_getHealth",
  "HealthController_getReadiness",
  "AdminAuthController_login",
  "LegalDocumentsController_read",
]);
const OPTIONAL_SESSION_OPERATION_IDS = new Set(["AuthController_logout"]);
const NO_FORBIDDEN_RESPONSE_OPERATION_IDS = new Set([
  "PublicSystemStateController_read",
  "HealthController_getHealth",
  "HealthController_getReadiness",
]);

function errorResponse(description: string) {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${ERROR_ENVELOPE_SCHEMA}` },
      },
    },
  };
}

function isParameter(parameter: OperationParameter): parameter is InlineOperationParameter {
  return !("$ref" in parameter);
}

function hasRequiredIfMatch(operation: OperationObject): boolean {
  return (
    operation.parameters?.some(
      (parameter) =>
        isParameter(parameter) &&
        parameter.in === "header" &&
        parameter.name.toLowerCase() === "if-match" &&
        parameter.required === true,
    ) ?? false
  );
}

function hasValidatedInput(operation: OperationObject): boolean {
  return operation.requestBody !== undefined || (operation.parameters?.length ?? 0) > 0;
}

export function applyOpenApiContract(document: OpenAPIObject): OpenAPIObject {
  document.components ??= {};
  document.components.schemas ??= {};
  document.components.responses ??= {};
  document.components.securitySchemes ??= {};

  document.components.schemas[ERROR_ENVELOPE_SCHEMA] = {
    type: "object",
    additionalProperties: false,
    properties: {
      error: {
        type: "object",
        additionalProperties: false,
        properties: {
          code: { type: "string" },
          details: { type: "object", additionalProperties: true },
          message: { type: "string" },
          request_id: { type: "string" },
        },
        required: ["code", "message", "request_id"],
      },
    },
    required: ["error"],
  };
  document.components.responses.BadRequestError =
    errorResponse("요청 본문·경로·쿼리 또는 헤더 형식 오류");
  document.components.responses.UnauthenticatedError = errorResponse("유효한 로그인 세션이 없음");
  document.components.responses.ForbiddenError = errorResponse("역할·Origin 또는 CSRF 검증 실패");
  document.components.responses.PreconditionRequiredError =
    errorResponse("필수 If-Match 헤더가 없음");
  document.components.responses.InternalServerError =
    errorResponse("요청 처리 중 안전하게 정규화된 내부 오류");
  document.components.securitySchemes[SESSION_SECURITY_SCHEME] = {
    description: "우리반 허브 HttpOnly 세션 쿠키",
    in: "cookie",
    name: SESSION_COOKIE_NAME,
    type: "apiKey",
  };
  document.components.securitySchemes.classhubAdminSession = {
    description: "관리자 전용 HttpOnly 세션 쿠키",
    in: "cookie",
    name: ADMIN_SESSION_COOKIE_NAME,
    type: "apiKey",
  };
  document.components.securitySchemes.classhubAdminChallenge = {
    description: "관리자 비밀번호 확인 후 TOTP 단계 쿠키",
    in: "cookie",
    name: ADMIN_CHALLENGE_COOKIE_NAME,
    type: "apiKey",
  };

  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (operation === undefined) continue;

      const operationId = operation.operationId ?? "";
      const scheme =
        operationId === "AdminAuthController_completeTotp"
          ? "classhubAdminChallenge"
          : path.startsWith("/api/v1/admin/")
            ? "classhubAdminSession"
            : SESSION_SECURITY_SCHEME;
      const sessionRequirement = { [scheme]: [] };
      if (PUBLIC_OPERATION_IDS.has(operationId)) {
        operation.security = [];
      } else if (OPTIONAL_SESSION_OPERATION_IDS.has(operationId)) {
        operation.security = [{}, sessionRequirement];
      } else {
        operation.security = [sessionRequirement];
        operation.responses["401"] ??= {
          $ref: "#/components/responses/UnauthenticatedError",
        };
      }

      if (hasValidatedInput(operation)) {
        operation.responses["400"] ??= {
          $ref: "#/components/responses/BadRequestError",
        };
      }
      if (!NO_FORBIDDEN_RESPONSE_OPERATION_IDS.has(operationId)) {
        operation.responses["403"] ??= {
          $ref: "#/components/responses/ForbiddenError",
        };
      }
      if (hasRequiredIfMatch(operation)) {
        operation.responses["428"] ??= {
          $ref: "#/components/responses/PreconditionRequiredError",
        };
      }
      operation.responses["500"] ??= {
        $ref: "#/components/responses/InternalServerError",
      };
    }
  }

  return document;
}
