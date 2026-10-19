import "reflect-metadata";

import { ValidationPipe } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import {
  GuardianConsentRequestDto,
  GuardianConsentStatusRequestDto,
  SignUpRequestDto,
} from "./auth.dto.js";

const pipe = new ValidationPipe({
  forbidNonWhitelisted: true,
  transform: true,
  whitelist: true,
});

function validate<T extends object>(metatype: new () => T, payload: object): Promise<T> {
  return pipe.transform(payload, { metatype, type: "body" });
}

const signUpBase = {
  approval_code: "123456",
  consents: { privacy: true, terms: true },
  display_name: "학생 하나",
  email: "student@example.com",
  password: "unit-test-safe-123",
  role: "student",
};

describe("guardian consent auth DTOs", () => {
  it("requires complete, exact document references when the optional snapshot is supplied", async () => {
    const legal_documents = Object.fromEntries(
      ["terms", "privacy_consent", "privacy_policy", "guardian_consent"].map((type) => [
        type,
        {
          id: "11111111-1111-4111-8111-111111111111",
          policy_version: "v1",
          content_sha256: "a".repeat(64),
        },
      ]),
    );
    await expect(
      validate(SignUpRequestDto, { ...signUpBase, age_route: "over_14", legal_documents }),
    ).resolves.toMatchObject({ legal_documents });
    for (const bad of [
      { ...legal_documents, privacy_policy: undefined },
      { ...legal_documents, extra: true },
      { ...legal_documents, terms: { ...legal_documents.terms, content_sha256: "bad" } },
    ]) {
      await expect(
        validate(SignUpRequestDto, { ...signUpBase, age_route: "over_14", legal_documents: bad }),
      ).rejects.toMatchObject({ status: 400 });
    }
  });
  it("accepts the over-14 signup contract without an age consent field", async () => {
    await expect(
      validate(SignUpRequestDto, { age_route: "over_14", ...signUpBase }),
    ).resolves.toMatchObject({ age_route: "over_14", consents: signUpBase.consents });
  });

  it("accepts only a nested guardian consent reference for the guardian route", async () => {
    const guardian_consent = {
      completion_token: "a".repeat(43),
      request_id: "11111111-1111-4111-8111-111111111111",
    };

    await expect(
      validate(SignUpRequestDto, {
        age_route: "guardian_consent",
        guardian_consent,
        ...signUpBase,
      }),
    ).resolves.toMatchObject({ age_route: "guardian_consent", guardian_consent });
    await expect(
      validate(SignUpRequestDto, { age_route: "guardian_consent", ...signUpBase }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      validate(SignUpRequestDto, {
        age_route: "guardian_consent",
        completion_token: guardian_consent.completion_token,
        request_id: guardian_consent.request_id,
        ...signUpBase,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects the removed age_over_14 consent key", async () => {
    await expect(
      validate(SignUpRequestDto, {
        age_route: "over_14",
        ...signUpBase,
        consents: { age_over_14: true, privacy: true, terms: true },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("requires a bound account role and an exact six-digit approval code", async () => {
    await expect(
      validate(SignUpRequestDto, { ...signUpBase, age_route: "over_14" }),
    ).resolves.toMatchObject({ approval_code: "123456", role: "student" });
    await expect(
      validate(SignUpRequestDto, {
        ...signUpBase,
        age_route: "over_14",
        approval_code: "12345",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      validate(SignUpRequestDto, {
        ...signUpBase,
        age_route: "over_14",
        approval_code: "12345a",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      validate(SignUpRequestDto, {
        ...signUpBase,
        age_route: "over_14",
        role: "administrator",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("normalizes guardian email and validates status credentials", async () => {
    await expect(
      validate(GuardianConsentRequestDto, { guardian_email: " Guardian@Example.com " }),
    ).resolves.toMatchObject({ guardian_email: "guardian@example.com" });
    await expect(
      validate(GuardianConsentStatusRequestDto, {
        completion_token: "b".repeat(43),
        request_id: "22222222-2222-4222-8222-222222222222",
      }),
    ).resolves.toBeInstanceOf(GuardianConsentStatusRequestDto);
  });

  it("rejects child account fields in a pre-consent request", async () => {
    await expect(
      validate(GuardianConsentRequestDto, {
        child_email: "student@example.com",
        display_name: "학생 하나",
        guardian_email: "guardian@example.com",
        password: "unit-test-safe-123",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
