import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const openApiPath = join(repositoryRoot, "packages", "api-client", "openapi", "openapi.json");
const generatedTypesPath = join(repositoryRoot, "packages", "api-client", "src", "generated.ts");

const document = JSON.parse(await readFile(openApiPath, "utf8"));
const generatedTypes = await readFile(generatedTypesPath, "utf8");
const schemas = document.components?.schemas ?? {};
const operations = [];

for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
  for (const method of ["get", "put", "post", "delete", "options", "head", "patch", "trace"]) {
    const operation = pathItem[method];
    if (operation !== undefined) {
      operations.push({ method, operation, path });
    }
  }
}

assert.equal(document.openapi, "3.0.0");
assert(operations.length > 0, "OpenAPI operation inventory must not be empty");

const expectedRequestSchemaProperties = {
  ApproveMemberDto: ["display_name_in_class", "student_number"],
  ConfirmEmailRequestDto: ["token"],
  CreateClassDto: [
    "academic_year",
    "edu_office_code",
    "expected_student_count",
    "grade",
    "name",
    "school_code",
  ],
  ConfirmGuardianConsentRequestDto: ["token", "legal_documents"],
  ConsentDocumentReferenceDto: ["id", "policy_version", "content_sha256"],
  LegalConsentSnapshotDto: ["terms", "privacy_consent", "privacy_policy", "guardian_consent"],
  CreateMembershipRequestDto: ["invite_code"],
  GuardianConsentReferenceDto: ["completion_token", "request_id"],
  GuardianConsentRequestDto: ["guardian_email", "legal_documents"],
  GuardianConsentStatusRequestDto: ["completion_token", "request_id"],
  LoginRequestDto: ["email", "password"],
  MemberReasonDto: ["reason"],
  SignUpRequestDto: [
    "age_route",
    "approval_code",
    "birth_date",
    "consents",
    "display_name",
    "email",
    "guardian_consent",
    "legal_documents",
    "password",
    "role",
  ],
  UpdateCurrentClassDto: ["expected_student_count", "name"],
};

for (const [schemaName, expectedProperties] of Object.entries(expectedRequestSchemaProperties)) {
  const schema = schemas[schemaName];
  assert(schema !== undefined, `${schemaName} schema is missing`);
  assert.equal(schema.type, "object", `${schemaName} must be an object schema`);
  assert.deepEqual(
    Object.keys(schema.properties ?? {}).sort(),
    [...expectedProperties].sort(),
    `${schemaName} property inventory drifted`,
  );
  assert.equal(
    generatedTypes.includes(`${schemaName}: Record<string, never>;`),
    false,
    `${schemaName} regressed to Record<string, never>`,
  );
}

/*
 * 속성도 `additionalProperties` 도 없는 object 는 생성기가 `Record<string, never>`
 * — 아무 속성도 담을 수 없는 객체 — 로 옮긴다. 정상 값조차 표현 못 하는 타입이다.
 *
 * ⚠️ **최상위 스키마만 보면 안 된다.** 2026-08-22 감사에서 layout payload 네 곳이
 * 중첩 property 라 이 검사를 그대로 통과했다(T-HUB-44). 손으로 적은 목록이 새 DTO 를
 * 또 빠뜨린 것과 같은 뿌리다 — 그래서 목록 대신 **문서 전체**를 훑는다.
 *
 * 예외는 `maxProperties: 0` 하나다. "본문 없음"을 일부러 못박은 자리라 그 타입이 맞다.
 */
const emptyObjectTrails = [];
const collectEmptyObjects = (node, trail) => {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((entry, index) => collectEmptyObjects(entry, `${trail}[${index}]`));
    return;
  }
  const declaresNothing =
    node.type === "object" &&
    node.maxProperties !== 0 &&
    node.additionalProperties === undefined &&
    node.allOf === undefined &&
    node.anyOf === undefined &&
    node.oneOf === undefined &&
    (node.properties === undefined || Object.keys(node.properties).length === 0);
  if (declaresNothing) emptyObjectTrails.push(trail);
  for (const [key, value] of Object.entries(node)) collectEmptyObjects(value, `${trail}.${key}`);
};
collectEmptyObjects(document, "#");
assert.deepEqual(emptyObjectTrails, [], "OpenAPI contains empty object schemas");

assert.deepEqual(Object.keys(schemas.SignUpConsentsDto?.properties ?? {}).sort(), [
  "privacy",
  "terms",
]);
assert.deepEqual([...schemas.LegalConsentSnapshotDto.required].sort(), [
  "guardian_consent",
  "privacy_consent",
  "privacy_policy",
  "terms",
]);
assert.equal(
  schemas.ConsentDocumentReferenceDto.properties.content_sha256.pattern,
  "^[0-9a-f]{64}$",
);
assert.deepEqual(schemas.SignUpRequestDto?.properties?.age_route?.enum, [
  "over_14",
  "guardian_consent",
]);
assert.deepEqual(schemas.SignUpRequestDto?.required, [
  "age_route",
  "consents",
  "display_name",
  "email",
  "password",
  "role",
]);
assert.equal(schemas.SignUpRequestDto?.properties?.approval_code?.deprecated, true);
assert.equal(schemas.SignUpRequestDto?.properties?.password?.minLength, 6);
assert.equal(schemas.GuardianConsentReferenceDto?.properties?.completion_token?.writeOnly, true);
assert.equal(schemas.ConfirmGuardianConsentRequestDto?.properties?.token?.writeOnly, true);
assert.deepEqual(schemas.ErrorEnvelope?.required, ["error"]);
assert.deepEqual(schemas.ErrorEnvelope?.properties?.error?.required, [
  "code",
  "message",
  "request_id",
]);

assert.deepEqual(document.components?.securitySchemes?.classhubSession, {
  description: "우리반 허브 HttpOnly 세션 쿠키",
  in: "cookie",
  name: "__Host-classhub_session",
  type: "apiKey",
});

const publicOperationIds = new Set([
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
const optionalSessionOperationIds = new Set(["AuthController_logout"]);
const healthOperationIds = new Set([
  "HealthController_getHealth",
  "HealthController_getReadiness",
  "PublicSystemStateController_read",
]);

for (const { operation, path, method } of operations) {
  const operationId = operation.operationId;
  assert.equal(typeof operationId, "string", `${method.toUpperCase()} ${path} has no operationId`);
  assert(operation.responses?.["500"] !== undefined, `${operationId} has no 500 response`);
  assert(
    Object.keys(operation.responses ?? {}).some((status) => /^[45]/u.test(status)),
    `${operationId} has no documented error response`,
  );
  if (healthOperationIds.has(operationId)) {
    assert.equal(operation.responses?.["403"], undefined, `${operationId} cannot return 403`);
  } else {
    assert(operation.responses?.["403"] !== undefined, `${operationId} has no 403 response`);
  }

  if (publicOperationIds.has(operationId)) {
    assert.deepEqual(operation.security, [], `${operationId} must be public`);
  } else if (optionalSessionOperationIds.has(operationId)) {
    assert.deepEqual(
      operation.security,
      [{}, { classhubSession: [] }],
      `${operationId} must allow an optional session`,
    );
  } else {
    const securityScheme =
      operationId === "AdminAuthController_completeTotp"
        ? "classhubAdminChallenge"
        : path.startsWith("/api/v1/admin/")
          ? "classhubAdminSession"
          : "classhubSession";
    assert.deepEqual(
      operation.security,
      [{ [securityScheme]: [] }],
      `${operationId} must require the session cookie`,
    );
    assert(operation.responses?.["401"] !== undefined, `${operationId} has no 401 response`);
  }
}

const expectedIfMatchOperations = new Set([
  "PATCH /api/v1/attendance-notifications/{id}",
  "DELETE /api/v1/my-assessments/{id}",
  "DELETE /api/v1/notices/{id}",
  "DELETE /api/v1/polls/{pollId}",
  "PATCH /api/v1/polls/{pollId}",
  "POST /api/v1/polls/{pollId}/close",
  "DELETE /api/v1/schedules/{id}",
  "DELETE /api/v1/supplies/{id}",
  "PATCH /api/v1/classes/current",
  "PATCH /api/v1/members/{id}/profile",
  "PATCH /api/v1/my-assessments/{id}",
  "PATCH /api/v1/notices/{id}",
  "PATCH /api/v1/schedules/{id}",
  "PATCH /api/v1/supplies/{id}",
  "POST /api/v1/my-assessments/{id}/complete",
  "POST /api/v1/attendance-notifications/{id}/acknowledge",
  "POST /api/v1/attendance-notifications/{id}/cancel",
  "POST /api/v1/elections/{electionId}/candidates",
  "POST /api/v1/elections/{electionId}/close",
  "POST /api/v1/elections/{electionId}/open",
  "POST /api/v1/elections/{electionId}/publish",
]);
const actualIfMatchOperations = new Set();

for (const { method, operation, path } of operations) {
  const ifMatch = operation.parameters?.find(
    (parameter) =>
      parameter?.in === "header" && String(parameter.name).toLowerCase() === "if-match",
  );
  if (ifMatch === undefined) continue;

  const operationKey = `${method.toUpperCase()} ${path}`;
  actualIfMatchOperations.add(operationKey);
  assert.equal(ifMatch.required, true, `${operationKey} If-Match must be required`);
  assert(operation.responses?.["428"] !== undefined, `${operationKey} has no 428 response`);
}
assert.deepEqual(actualIfMatchOperations, expectedIfMatchOperations);

for (const forbiddenPrefix of ["/api/v1/local-test-admin"]) {
  assert.equal(
    Object.keys(document.paths).some((path) => path.startsWith(forbiddenPrefix)),
    false,
    `Dormant operational path is exposed: ${forbiddenPrefix}`,
  );
}

process.stdout.write(
  `OpenAPI contract verified: ${operations.length} operations, 0 empty object schemas, ${expectedIfMatchOperations.size} required If-Match headers, cookie security, shared errors. PASS\n`,
);
