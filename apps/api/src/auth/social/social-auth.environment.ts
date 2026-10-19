import { z } from "zod";

const flag = () =>
  z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true");
// 서버 묶음(docker compose)은 비워 둔 설정을 빈 문자열로 넘긴다. 콘솔 키를 받기 전에도 서버가 뜨도록
// 빈 값은 "설정 안 함"으로 본다(NEIS_API_KEY와 같은 방식). 켠 제공자의 키가 비면 아래 검증이 거절한다.
const optionalSetting = () =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined);
export const socialEnvironmentShape = {
  SOCIAL_AUTH_ENABLED: flag(),
  SOCIAL_GOOGLE_ENABLED: flag(),
  SOCIAL_NAVER_ENABLED: flag(),
  SOCIAL_KAKAO_ENABLED: flag(),
  SOCIAL_GOOGLE_CLIENT_ID: optionalSetting(),
  SOCIAL_GOOGLE_CLIENT_SECRET: optionalSetting(),
  SOCIAL_NAVER_CLIENT_ID: optionalSetting(),
  SOCIAL_NAVER_CLIENT_SECRET: optionalSetting(),
  SOCIAL_KAKAO_CLIENT_ID: optionalSetting(),
  SOCIAL_KAKAO_CLIENT_SECRET: optionalSetting(),
  SOCIAL_AUTH_FLOW_KEY: optionalSetting().pipe(
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/u)
      .optional(),
  ),
  SOCIAL_AUTH_MOCK_ISSUER: z.url().optional(),
};
export const socialSettingsSchema = z.object(socialEnvironmentShape);
export type SocialSettings = z.infer<typeof socialSettingsSchema>;
export const socialProviders = ["google", "naver", "kakao"] as const;
export type SocialProvider = (typeof socialProviders)[number];
export function isSocialProvider(value: string): value is SocialProvider {
  return socialProviders.some((provider) => provider === value);
}

export function validateSocialEnvironment(
  environment: Record<string, unknown>,
  context: z.RefinementCtx,
) {
  if (environment.SOCIAL_AUTH_ENABLED !== true) return;
  const issue = (path: string, message: string) =>
    context.addIssue({ code: "custom", path: [path], message });
  if (
    typeof environment.SOCIAL_AUTH_FLOW_KEY !== "string" ||
    Buffer.from(environment.SOCIAL_AUTH_FLOW_KEY, "base64url").length !== 32
  )
    issue(
      "SOCIAL_AUTH_FLOW_KEY",
      "Social login requires an independent 32-byte flow encryption key.",
    );
  if (environment.SOCIAL_AUTH_MOCK_ISSUER) {
    const mock = new URL(String(environment.SOCIAL_AUTH_MOCK_ISSUER));
    const app = new URL(String(environment.PUBLIC_APP_ORIGIN));
    const api = new URL(String(environment.PUBLIC_API_ORIGIN));
    if (
      environment.NODE_ENV === "production" ||
      !["localhost", "127.0.0.1"].includes(mock.hostname) ||
      !["localhost", "127.0.0.1"].includes(app.hostname) ||
      !["localhost", "127.0.0.1"].includes(api.hostname) ||
      mock.username ||
      mock.password ||
      mock.search ||
      mock.hash
    )
      issue(
        "SOCIAL_AUTH_MOCK_ISSUER",
        "Mock identity providers are restricted to isolated loopback development/tests.",
      );
  } else {
    const app = new URL(String(environment.PUBLIC_APP_ORIGIN));
    const api = new URL(String(environment.PUBLIC_API_ORIGIN));
    // 2026-10-01 사용자 결정: 실제 서버 전에는 이 PC(localhost)에서 구글·카카오·네이버를 시험한다.
    // 세 회사 모두 개발용 http://localhost 돌아올 주소를 받는다. development에서 루프백일 때만 허용한다.
    const loopbackDevelopment =
      environment.NODE_ENV === "development" &&
      [app, api].every(
        (url) => url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname),
      );
    if (
      !loopbackDevelopment &&
      (app.protocol !== "https:" ||
        api.protocol !== "https:" ||
        app.hostname.endsWith(".trycloudflare.com") ||
        api.hostname.endsWith(".trycloudflare.com"))
    )
      issue("SOCIAL_AUTH_ENABLED", "Social login requires stable HTTPS application/API domains.");
    if (app.origin !== api.origin)
      issue(
        "PUBLIC_API_ORIGIN",
        "Social login uses one public application/API origin for host-only secure cookies.",
      );
    for (const provider of socialProviders) {
      const prefix = `SOCIAL_${provider.toUpperCase()}`;
      if (
        environment[`${prefix}_ENABLED`] === true &&
        (!environment[`${prefix}_CLIENT_ID`] || !environment[`${prefix}_CLIENT_SECRET`])
      )
        issue(
          `${prefix}_CLIENT_ID`,
          "An enabled provider requires credentials from its developer console.",
        );
    }
  }
  if (
    environment.DATABASE_ENGINE === "mariadb" &&
    !["social", "all"].includes(String(environment.AUTH_DATABASE_EXTENSIONS))
  )
    issue(
      "AUTH_DATABASE_EXTENSIONS",
      "Install the approved social authentication database/ACL extension before enabling it.",
    );
}
