import { z } from "zod";

import { ageRouteForBirthDate, isAcceptableBirthDate } from "../../lib/birth-date";
import {
  BLOCKED_DISPLAY_NAME_MESSAGE,
  containsBlockedDisplayNameWord,
} from "../../lib/display-name-policy";
import { newPasswordSchema, passwordConfirmationSchema } from "../../lib/password-policy";
import { codePointLength } from "../../lib/text";

export const guardianEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("보호자 이메일 형식을 확인해 주세요."));

/** social: 비밀번호 없이 가입. birthDateRequired: 서버가 생년월일을 받는 환경(나이 경로는 생년월일로 정한다). */
export const createSignUpSchema = (social: boolean, birthDateRequired: boolean) =>
  z
    .object({
      age_route: z.enum(["over_14", "guardian_consent"]).optional(),
      birth_date: z.string(),
      confirm_password: social ? z.string() : passwordConfirmationSchema,
      display_name: z
        .string()
        .trim()
        .refine((value) => codePointLength(value) >= 2, "기본 이름은 2자 이상 입력해 주세요.")
        .refine((value) => codePointLength(value) <= 20, "기본 이름은 20자 이하로 입력해 주세요.")
        .refine((value) => !containsBlockedDisplayNameWord(value), BLOCKED_DISPLAY_NAME_MESSAGE),
      email: z.string().trim().toLowerCase().pipe(z.email("이메일 형식을 확인해 주세요.")),
      guardian_email: z.string(),
      password: social ? z.string() : newPasswordSchema,
      privacy: z.boolean().refine(Boolean, "개인정보 수집·이용 동의가 필요해요."),
      role: z.enum(["teacher", "student"]).optional(),
      terms: z.boolean().refine(Boolean, "이용약관 동의가 필요해요."),
    })
    .superRefine((values, context) => {
      if (!social && values.confirm_password !== values.password) {
        context.addIssue({
          code: "custom",
          message: "비밀번호가 서로 일치하지 않아요.",
          path: ["confirm_password"],
        });
      }
      // 생년월일은 선택(P-025③). 필수인 예전 환경이거나 입력했을 때만 확인한다.
      if (birthDateRequired || values.birth_date !== "") {
        if (!isAcceptableBirthDate(values.birth_date)) {
          context.addIssue({
            code: "custom",
            message: "생년월일을 확인해 주세요.",
            path: ["birth_date"],
          });
          return;
        }
        if (values.age_route !== ageRouteForBirthDate(values.birth_date)) {
          context.addIssue({
            code: "custom",
            message: "생년월일을 다시 입력해 주세요.",
            path: ["birth_date"],
          });
          return;
        }
      }
      if (values.age_route === undefined) {
        context.addIssue({
          code: "custom",
          message: "연령에 맞는 가입 방법을 선택해 주세요.",
          path: ["age_route"],
        });
        return;
      }
      if (values.role === undefined) {
        context.addIssue({
          code: "custom",
          message: "가입할 계정 유형을 선택해 주세요.",
          path: ["role"],
        });
      }
      if (values.age_route !== "guardian_consent") return;

      const guardianEmail = guardianEmailSchema.safeParse(values.guardian_email);
      if (!guardianEmail.success) {
        context.addIssue({
          code: "custom",
          message: guardianEmail.error.issues[0]?.message ?? "보호자 이메일을 확인해 주세요.",
          path: ["guardian_email"],
        });
        return;
      }
      if (guardianEmail.data === values.email.trim().toLowerCase()) {
        context.addIssue({
          code: "custom",
          message: "학생 이메일과 보호자 이메일은 서로 달라야 해요.",
          path: ["email"],
        });
      }
    });

export type SignUpForm = z.infer<ReturnType<typeof createSignUpSchema>>;
export const consentFields = ["terms", "privacy"] as const;

export type GuardianRequestStatus = "approved" | "delivery_failed" | "expired" | "pending";

export interface GuardianRequestState {
  completionToken: string;
  expiresAt: string;
  requestId: string;
  status: GuardianRequestStatus;
}
