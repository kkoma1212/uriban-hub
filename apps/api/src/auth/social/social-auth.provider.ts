import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as oauth from "oauth4webapi";
import {
  socialEnvironmentShape,
  socialProviders,
  socialSettingsSchema,
  validateSocialEnvironment,
  type SocialProvider,
  type SocialSettings,
} from "./social-auth.environment.js";

export interface SocialIdentity {
  provider: SocialProvider;
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  /** 가입 화면의 기본 이름을 미리 채우는 데만 쓴다(2026-10-01 사용자 결정). */
  name?: string | null;
  /** 본인이 '프로필 사진 쓰기'를 고른 경우에만 서버가 받아 온다. 회사 이미지 서버 주소만 남긴다. */
  picture?: string | null;
}

// 프로필 사진은 각 회사 이미지 서버에서만 받는다(서버가 임의 주소로 요청하지 않게).
const PICTURE_HOSTS: Record<SocialProvider, readonly string[]> = {
  google: [".googleusercontent.com"],
  kakao: [".kakaocdn.net"],
  naver: [".pstatic.net"],
};

export function allowedPictureUrl(provider: SocialProvider, value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    return PICTURE_HOSTS[provider].some((suffix) => url.hostname.endsWith(suffix))
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function profileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFC").trim();
  return name.length > 0 && [...name].length <= 40 && !/[\u0000-\u001f\u007f]/u.test(name)
    ? name
    : null;
}
export interface OAuthProof {
  state: string;
  verifier: string;
  nonce: string;
}
export function socialDenied() {
  return new UnauthorizedException({
    code: "SOCIAL_AUTH_INVALID",
    message: "빠른 로그인 확인이 만료됐거나 유효하지 않습니다. 다시 시작해 주세요.",
  });
}
const metadata: Record<SocialProvider, oauth.AuthorizationServer> = {
  google: {
    issuer: "https://accounts.google.com",
    authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    token_endpoint: "https://oauth2.googleapis.com/token",
    jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
    id_token_signing_alg_values_supported: ["RS256"],
  },
  naver: {
    issuer: "https://nid.naver.com",
    authorization_endpoint: "https://nid.naver.com/oauth2/authorize",
    token_endpoint: "https://nid.naver.com/oauth2/token",
    jwks_uri: "https://nid.naver.com/oauth2/jwks",
    id_token_signing_alg_values_supported: ["RS256"],
  },
  kakao: {
    issuer: "https://kauth.kakao.com",
    authorization_endpoint: "https://kauth.kakao.com/oauth/authorize",
    token_endpoint: "https://kauth.kakao.com/oauth/token",
    jwks_uri: "https://kauth.kakao.com/.well-known/jwks.json",
    id_token_signing_alg_values_supported: ["RS256"],
  },
};

@Injectable()
export class SocialAuthProvider {
  private readonly logger = new Logger(SocialAuthProvider.name);
  readonly settings: SocialSettings;
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {
    const input = Object.fromEntries(
      Object.keys(socialEnvironmentShape).map((key) => {
        const value: unknown = config.get(key);
        return [key, typeof value === "boolean" ? String(value) : value];
      }),
    );
    this.settings = socialSettingsSchema.parse(input);
    const failures: string[] = [];
    validateSocialEnvironment(
      {
        ...this.settings,
        PUBLIC_APP_ORIGIN: config.get("PUBLIC_APP_ORIGIN"),
        PUBLIC_API_ORIGIN: config.get("PUBLIC_API_ORIGIN"),
        DATABASE_ENGINE: config.get("DATABASE_ENGINE"),
        AUTH_DATABASE_EXTENSIONS: config.get("AUTH_DATABASE_EXTENSIONS"),
        NODE_ENV: config.get("NODE_ENV"),
      },
      {
        addIssue: (issue) => {
          failures.push(typeof issue === "string" ? issue : String(issue.path?.[0]));
        },
      } as Parameters<typeof validateSocialEnvironment>[1],
    );
    if (failures.length)
      throw new Error(`Invalid social authentication configuration: ${failures.join(", ")}`);
  }
  enabled(): SocialProvider[] {
    return this.settings.SOCIAL_AUTH_ENABLED
      ? socialProviders.filter(
          (provider) =>
            this.settings[`SOCIAL_${provider.toUpperCase()}_ENABLED` as keyof SocialSettings] ===
            true,
        )
      : [];
  }
  require(provider: SocialProvider) {
    if (!this.enabled().includes(provider)) throw new NotFoundException();
  }
  currentIssuer(provider: SocialProvider): string {
    return this.provider(provider).as.issuer;
  }
  flowKey(): Buffer {
    if (!this.settings.SOCIAL_AUTH_ENABLED || !this.settings.SOCIAL_AUTH_FLOW_KEY)
      throw new NotFoundException();
    return Buffer.from(this.settings.SOCIAL_AUTH_FLOW_KEY, "base64url");
  }
  private provider(provider: SocialProvider) {
    this.require(provider);
    const mock = this.settings.SOCIAL_AUTH_MOCK_ISSUER;
    const issuer = mock ? `${mock.replace(/\/$/u, "")}/${provider}` : undefined;
    const as = issuer
      ? {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          id_token_signing_alg_values_supported: ["RS256"],
        }
      : metadata[provider];
    const client: oauth.Client = {
      client_id: mock
        ? `classhub-mock-${provider}`
        : String(
            this.settings[`SOCIAL_${provider.toUpperCase()}_CLIENT_ID` as keyof SocialSettings],
          ),
      id_token_signed_response_alg: "RS256",
    };
    const secret = mock
      ? "mock-provider-only"
      : String(
          this.settings[`SOCIAL_${provider.toUpperCase()}_CLIENT_SECRET` as keyof SocialSettings],
        );
    const redirectUri = `${new URL(this.config.getOrThrow<string>("PUBLIC_API_ORIGIN")).origin}/api/v1/auth/social/${provider}/callback`;
    return {
      as,
      client,
      clientAuth: oauth.ClientSecretPost(secret),
      redirectUri,
      mock: mock !== undefined,
    };
  }
  async begin(provider: SocialProvider) {
    const { as, client, redirectUri } = this.provider(provider);
    const proof = {
      state: oauth.generateRandomState(),
      verifier: oauth.generateRandomCodeVerifier(),
      nonce: oauth.generateRandomNonce(),
    };
    const url = new URL(as.authorization_endpoint!);
    const params = {
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      // 2026-10-01: Kakao account_email failed with KOE205 on a non-business app; email is optional
      // here (signup asks for it and verifies it by code). Name/picture pre-fill the first signup
      // (Kakao consent items profile_nickname/profile_image must be on in its console).
      scope:
        provider === "google"
          ? "openid email profile"
          : provider === "kakao"
            ? "openid profile_nickname profile_image"
            : "openid",
      state: proof.state,
      nonce: proof.nonce,
      code_challenge: await oauth.calculatePKCECodeChallenge(proof.verifier),
      code_challenge_method: "S256",
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return { url: url.href, proof };
  }
  async complete(
    provider: SocialProvider,
    parameters: URLSearchParams,
    proof: OAuthProof,
  ): Promise<SocialIdentity> {
    const { as, client, clientAuth, redirectUri, mock } = this.provider(provider);
    try {
      const options = {
        signal: AbortSignal.timeout(8000),
        [oauth.allowInsecureRequests]: mock,
        [oauth.customFetch]: (url: string, init: object) =>
          fetch(url, { ...init, redirect: "error" }),
      };
      const callback = oauth.validateAuthResponse(as, client, parameters, proof.state);
      const response = await oauth.authorizationCodeGrantRequest(
        as,
        client,
        clientAuth,
        callback,
        redirectUri,
        proof.verifier,
        { ...options, additionalParameters: provider === "naver" ? { state: proof.state } : {} },
      );
      const tokens = await oauth.processAuthorizationCodeResponse(as, client, response, {
        expectedNonce: proof.nonce,
        requireIdToken: true,
      });
      await oauth.validateApplicationLevelSignature(as, response, options);
      const claims = oauth.getValidatedIdTokenClaims(tokens);
      if (
        !claims ||
        typeof claims.sub !== "string" ||
        claims.sub.length === 0 ||
        claims.sub.length > 255 ||
        /[\u0000-\u001f\u007f]/u.test(claims.sub)
      )
        throw socialDenied();
      const email =
        typeof claims.email === "string" &&
        claims.email.length <= 320 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(claims.email)
          ? claims.email.toLowerCase().trim()
          : null;
      return {
        provider,
        issuer: as.issuer,
        subject: claims.sub,
        email,
        emailVerified:
          email !== null && claims.email_verified === true && (provider !== "naver" || mock),
        name: profileName(claims.name ?? claims.nickname),
        picture: allowedPictureUrl(provider, claims.picture),
      };
    } catch (error) {
      // 화면에는 한 가지 안내만 보이므로, 원인은 서버 기록에 남긴다. 토큰·응답 본문·개인정보는 남기지 않는다.
      const kind = error instanceof Error ? error.name : typeof error;
      const code =
        typeof (error as { code?: unknown })?.code === "string"
          ? (error as { code: string }).code
          : "-";
      // 회사 서버가 거절하면 표준 오류 코드(error)와 설명(error_description)만 덧붙인다.
      const body =
        error instanceof oauth.ResponseBodyError
          ? ` error=${error.error} description=${String(error.error_description ?? "").slice(0, 160)} status=${error.status}`
          : "";
      const detail = (error instanceof Error ? error.message.slice(0, 160) : "") + body;
      this.logger.warn(`social callback rejected: provider=${provider} ${kind} ${code} ${detail}`);
      throw socialDenied();
    }
  }
}
