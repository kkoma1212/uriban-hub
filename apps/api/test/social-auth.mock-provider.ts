import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { SocialProvider } from "../src/auth/social/social-auth.environment.js";

export type MockIdentity = { subject: string; email: string; verified: boolean };
export type MockFault = "nonce" | "issuer" | "audience" | "signature" | "expired" | "pkce";

/** A loopback-only OIDC server: real code exchange, PKCE checks and signed JWT/JWKS, no application bypass. */
export async function startMockSocialProvider() {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const wrongKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = {
    ...key.publicKey.export({ format: "jwk" }),
    kid: "isolated-qa",
    use: "sig",
    alg: "RS256",
  };
  const identities = new Map<SocialProvider, MockIdentity>();
  const codes = new Map<
    string,
    {
      provider: SocialProvider;
      params: URLSearchParams;
      identity: MockIdentity;
      fault: MockFault | undefined;
    }
  >();
  let nextFault: MockFault | undefined;
  let tokenExchanges = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, origin);
      const [, name, action] = url.pathname.split("/");
      if (!["google", "naver", "kakao"].includes(name ?? "")) {
        response.writeHead(404).end();
        return;
      }
      const provider = name as SocialProvider;
      response.setHeader("Cache-Control", "no-store");
      if (action === "jwks") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      if (action === "authorize") {
        const identity = identities.get(provider);
        const p = url.searchParams;
        if (
          !identity ||
          p.get("client_id") !== `classhub-mock-${provider}` ||
          p.get("response_type") !== "code" ||
          p.get("scope") !==
            {
              google: "openid email profile",
              naver: "openid",
              kakao: "openid profile_nickname profile_image",
            }[provider] ||
          p.get("code_challenge_method") !== "S256" ||
          !p.get("nonce") ||
          !p.get("state")
        ) {
          response.writeHead(400).end();
          return;
        }
        const destination = new URL(p.get("redirect_uri")!);
        if (
          destination.hostname !== "localhost" ||
          destination.pathname !== `/api/v1/auth/social/${provider}/callback`
        ) {
          response.writeHead(400).end();
          return;
        }
        const code = randomBytes(32).toString("base64url");
        codes.set(code, { provider, params: p, identity, fault: nextFault });
        nextFault = undefined;
        destination.searchParams.set("code", code);
        destination.searchParams.set("state", p.get("state")!);
        response.writeHead(302, { Location: destination.href }).end();
        return;
      }
      if (action === "token" && request.method === "POST") {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 16384) throw new Error("oversized mock request");
        }
        const p = new URLSearchParams(body);
        const code = p.get("code") ?? "";
        const item = codes.get(code);
        codes.delete(code);
        response.setHeader("Content-Type", "application/json");
        if (
          !item ||
          item.provider !== provider ||
          p.get("client_id") !== item.params.get("client_id") ||
          p.get("client_secret") !== "mock-provider-only" ||
          p.get("redirect_uri") !== item.params.get("redirect_uri") ||
          p.get("grant_type") !== "authorization_code" ||
          (provider === "naver" && p.get("state") !== item.params.get("state")) ||
          item.fault === "pkce" ||
          createHash("sha256")
            .update(p.get("code_verifier") ?? "")
            .digest("base64url") !== item.params.get("code_challenge")
        ) {
          response.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        tokenExchanges++;
        const now = Math.floor(Date.now() / 1000);
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
        const header = encode({ alg: "RS256", kid: "isolated-qa", typ: "JWT" });
        const claims = encode({
          iss: item.fault === "issuer" ? "https://wrong.invalid" : `${origin}/${provider}`,
          aud: item.fault === "audience" ? "wrong-client" : p.get("client_id"),
          sub: item.identity.subject,
          email: item.identity.email,
          email_verified: item.identity.verified,
          nonce: item.fault === "nonce" ? "wrong-nonce" : item.params.get("nonce"),
          iat: now,
          exp: item.fault === "expired" ? now - 600 : now + 300,
        });
        const unsigned = `${header}.${claims}`;
        const signature = sign(
          "RSA-SHA256",
          Buffer.from(unsigned),
          item.fault === "signature" ? wrongKey.privateKey : key.privateKey,
        ).toString("base64url");
        response.end(
          JSON.stringify({
            access_token: randomBytes(32).toString("base64url"),
            token_type: "Bearer",
            expires_in: 300,
            id_token: `${unsigned}.${signature}`,
          }),
        );
        return;
      }
      response.writeHead(404).end();
    })().catch(() => {
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    identity(provider: SocialProvider, identity: MockIdentity) {
      identities.set(provider, identity);
    },
    fault(value: MockFault) {
      nextFault = value;
    },
    get tokenExchanges() {
      return tokenExchanges;
    },
    async authorize(url: string) {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status !== 302)
        throw new Error(`Mock authorization failed (${response.status})`);
      return new URL(response.headers.get("location")!).searchParams;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
