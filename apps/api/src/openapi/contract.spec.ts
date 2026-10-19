import type { OpenAPIObject } from "@nestjs/swagger";

import { SESSION_COOKIE_NAME } from "../auth/session-cookie.js";
import { applyOpenApiContract } from "./contract.js";

it("keeps public operating status anonymous and preserves its unavailable response", () => {
  const document = documentFixture();
  document.paths["/api/v1/public/system-state"] = {
    get: {
      operationId: "PublicSystemStateController_read",
      responses: {
        "200": { description: "public" },
        "503": { description: "SYSTEM_STATE_UNAVAILABLE" },
      },
    },
  };
  const operation = applyOpenApiContract(document).paths["/api/v1/public/system-state"]!.get!;
  expect(operation.security).toEqual([]);
  expect(operation.responses["401"]).toBeUndefined();
  expect(operation.responses["403"]).toBeUndefined();
  expect(operation.responses["503"]).toEqual({ description: "SYSTEM_STATE_UNAVAILABLE" });
});

function documentFixture(): OpenAPIObject {
  return {
    components: {},
    info: { title: "fixture", version: "1" },
    openapi: "3.0.0",
    paths: {
      "/api/v1/auth/guardian-consent-requests": {
        post: {
          operationId: "AuthController_requestGuardianConsent",
          requestBody: {
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: { "202": { description: "accepted" } },
        },
      },
      "/api/v1/auth/guardian-consent-requests/status": {
        post: {
          operationId: "AuthController_getGuardianConsentStatus",
          requestBody: {
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: { "200": { description: "ok" } },
        },
      },
      "/api/v1/auth/guardian-consents/confirm": {
        post: {
          operationId: "AuthController_confirmGuardianConsent",
          requestBody: {
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: { "200": { description: "ok" } },
        },
      },
      "/api/v1/auth/login": {
        post: {
          operationId: "AuthController_login",
          requestBody: {
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: { "200": { description: "ok" } },
        },
      },
      "/api/v1/auth/logout": {
        post: {
          operationId: "AuthController_logout",
          responses: { "200": { description: "ok" } },
        },
      },
      "/api/v1/items/{id}": {
        patch: {
          operationId: "ItemsController_update",
          parameters: [
            {
              in: "header",
              name: "If-Match",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "ok" },
            "400": { description: "specific bad request" },
          },
        },
      },
      "/api/v1/items": {
        get: {
          operationId: "ItemsController_list",
          responses: { "200": { description: "ok" } },
        },
      },
      "/healthz": {
        get: {
          operationId: "HealthController_getHealth",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

describe("applyOpenApiContract", () => {
  it("keeps public legal reads and login separate from administrator challenge and session cookies", () => {
    const input = documentFixture();
    for (const [path, method, operationId] of [
      ["/api/v1/legal/documents/{documentType}", "get", "LegalDocumentsController_read"],
      ["/api/v1/admin/auth/login", "post", "AdminAuthController_login"],
      ["/api/v1/admin/auth/totp", "post", "AdminAuthController_completeTotp"],
      ["/api/v1/admin/auth/renew", "post", "AdminAuthController_renew"],
    ] as const) {
      input.paths[path] = {
        [method]: { operationId, responses: { "200": { description: "ok" } } },
      };
    }
    const document = applyOpenApiContract(input);
    expect(document.paths["/api/v1/legal/documents/{documentType}"]?.get?.security).toEqual([]);
    expect(document.paths["/api/v1/admin/auth/login"]?.post?.security).toEqual([]);
    expect(document.paths["/api/v1/admin/auth/totp"]?.post?.security).toEqual([
      { classhubAdminChallenge: [] },
    ]);
    expect(document.paths["/api/v1/admin/auth/renew"]?.post?.security).toEqual([
      { classhubAdminSession: [] },
    ]);
  });
  it("adds the shared error envelope and cookie scheme", () => {
    const document = applyOpenApiContract(documentFixture());

    expect(document.components?.schemas?.ErrorEnvelope).toEqual(
      expect.objectContaining({ required: ["error"], type: "object" }),
    );
    expect(document.components?.securitySchemes?.classhubSession).toEqual({
      description: "우리반 허브 HttpOnly 세션 쿠키",
      in: "cookie",
      name: SESSION_COOKIE_NAME,
      type: "apiKey",
    });
    expect(Object.keys(document.components?.responses ?? {})).toEqual([
      "BadRequestError",
      "UnauthenticatedError",
      "ForbiddenError",
      "PreconditionRequiredError",
      "InternalServerError",
    ]);
  });

  it("classifies public, optional-session, and authenticated operations", () => {
    const document = applyOpenApiContract(documentFixture());

    expect(document.paths["/healthz"]?.get?.security).toEqual([]);
    expect(document.paths["/api/v1/auth/login"]?.post?.security).toEqual([]);
    expect(document.paths["/api/v1/auth/guardian-consent-requests"]?.post?.security).toEqual([]);
    expect(document.paths["/api/v1/auth/guardian-consent-requests/status"]?.post?.security).toEqual(
      [],
    );
    expect(document.paths["/api/v1/auth/guardian-consents/confirm"]?.post?.security).toEqual([]);
    expect(document.paths["/api/v1/auth/logout"]?.post?.security).toEqual([
      {},
      { classhubSession: [] },
    ]);
    expect(document.paths["/api/v1/items/{id}"]?.patch?.security).toEqual([
      { classhubSession: [] },
    ]);
    expect(document.paths["/api/v1/items"]?.get?.security).toEqual([{ classhubSession: [] }]);
  });

  it("adds only applicable standard errors and preserves specific responses", () => {
    const document = applyOpenApiContract(documentFixture());
    const updateResponses = document.paths["/api/v1/items/{id}"]?.patch?.responses;

    expect(updateResponses?.["400"]).toEqual({ description: "specific bad request" });
    expect(updateResponses?.["401"]).toEqual({
      $ref: "#/components/responses/UnauthenticatedError",
    });
    expect(updateResponses?.["403"]).toEqual({
      $ref: "#/components/responses/ForbiddenError",
    });
    expect(updateResponses?.["428"]).toEqual({
      $ref: "#/components/responses/PreconditionRequiredError",
    });
    expect(updateResponses?.["500"]).toEqual({
      $ref: "#/components/responses/InternalServerError",
    });

    const listResponses = document.paths["/api/v1/items"]?.get?.responses;
    expect(listResponses?.["401"]).toBeDefined();
    expect(listResponses?.["403"]).toBeDefined();
    expect(listResponses?.["500"]).toBeDefined();

    const healthResponses = document.paths["/healthz"]?.get?.responses;
    expect(healthResponses?.["400"]).toBeUndefined();
    expect(healthResponses?.["401"]).toBeUndefined();
    expect(healthResponses?.["403"]).toBeUndefined();
    expect(healthResponses?.["428"]).toBeUndefined();
    expect(healthResponses?.["500"]).toBeDefined();
  });
});
