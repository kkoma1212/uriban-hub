import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  decodeBase64Url,
  encryptPushPayload,
  MAX_PUSH_PLAINTEXT_BYTES,
  parseVapidKeys,
  vapidAuthorization,
} from "./web-push-crypto.js";

// RFC 8291 §5 / Appendix A 고정 입력과 정답.
const RFC = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** 수신 브라우저 쪽 복호화(RFC 8291 역방향). 운영 코드가 아니라 왕복 검증용이다. */
function decryptAsUserAgent(body: Buffer, uaPrivate: Buffer, authSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const keyLength = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + keyLength);
  const ciphertext = body.subarray(21 + keyLength);
  const ua = createECDH("prime256v1");
  ua.setPrivateKey(uaPrivate);
  const secret = ua.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, authSecret, info, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  expect(padded.at(-1)).toBe(0x02);
  return padded.subarray(0, -1);
}

describe("encryptPushPayload", () => {
  it("RFC 8291 부록 A의 정답 암호문을 바이트 단위로 재현한다", () => {
    const body = encryptPushPayload({
      plaintext: decodeBase64Url(RFC.plaintext),
      userAgentPublicKey: decodeBase64Url(RFC.uaPublic),
      authSecret: decodeBase64Url(RFC.authSecret),
      applicationServerPrivateKey: decodeBase64Url(RFC.asPrivate),
      salt: decodeBase64Url(RFC.salt),
    });
    expect(body.toString("base64url")).toBe(RFC.body);
  });

  it("임시 키로 만든 본문을 수신 브라우저가 복호화할 수 있다", () => {
    const plaintext = Buffer.from(JSON.stringify({ title: "일정 변경", path: "/schedules/1" }));
    const body = encryptPushPayload({
      plaintext,
      userAgentPublicKey: decodeBase64Url(RFC.uaPublic),
      authSecret: decodeBase64Url(RFC.authSecret),
    });
    const decrypted = decryptAsUserAgent(
      body,
      decodeBase64Url(RFC.uaPrivate),
      decodeBase64Url(RFC.authSecret),
    );
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("메시지마다 다른 임시 키와 salt를 쓴다", () => {
    const input = {
      plaintext: Buffer.from("same"),
      userAgentPublicKey: decodeBase64Url(RFC.uaPublic),
      authSecret: decodeBase64Url(RFC.authSecret),
    };
    const first = encryptPushPayload(input);
    const second = encryptPushPayload(input);
    expect(first.subarray(0, 16).equals(second.subarray(0, 16))).toBe(false);
    expect(first.subarray(21, 86).equals(second.subarray(21, 86))).toBe(false);
  });

  it("잘못된 구독 키와 너무 큰 본문을 거부한다", () => {
    const valid = {
      plaintext: Buffer.from("x"),
      userAgentPublicKey: decodeBase64Url(RFC.uaPublic),
      authSecret: decodeBase64Url(RFC.authSecret),
    };
    expect(() => encryptPushPayload({ ...valid, userAgentPublicKey: Buffer.alloc(65) })).toThrow(
      "Invalid push subscription keys.",
    );
    expect(() => encryptPushPayload({ ...valid, authSecret: Buffer.alloc(8) })).toThrow(
      "Invalid push subscription keys.",
    );
    expect(() =>
      encryptPushPayload({ ...valid, plaintext: Buffer.alloc(MAX_PUSH_PLAINTEXT_BYTES + 1) }),
    ).toThrow("Push payload is too large.");
  });
});

describe("VAPID", () => {
  const keys = parseVapidKeys(RFC.asPublic, RFC.asPrivate);

  it("공개키가 비밀키와 맞지 않으면 거부한다", () => {
    expect(() => parseVapidKeys(RFC.uaPublic, RFC.asPrivate)).toThrow("does not match");
    expect(() => parseVapidKeys("short", RFC.asPrivate)).toThrow("uncompressed P-256");
    expect(() => parseVapidKeys(RFC.asPublic, "not+base64url")).toThrow("Invalid base64url");
  });

  it("푸시 서비스 origin을 대상으로 검증 가능한 ES256 토큰을 만든다", () => {
    const header = vapidAuthorization(
      new URL("https://fcm.googleapis.com/fcm/send/abc"),
      "mailto:operator@example.com",
      keys,
      1_800_000_000,
    );
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/u.exec(header);
    expect(match).not.toBeNull();
    const [, encodedHeader = "", encodedClaims = "", signature = "", publicKey = ""] = match ?? [];
    expect(publicKey).toBe(RFC.asPublic);
    expect(JSON.parse(Buffer.from(encodedHeader, "base64url").toString())).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    expect(JSON.parse(Buffer.from(encodedClaims, "base64url").toString())).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: 1_800_000_000 + 12 * 60 * 60,
      sub: "mailto:operator@example.com",
    });
    const verificationKey = createPublicKey({
      format: "jwk",
      key: {
        kty: "EC",
        crv: "P-256",
        x: keys.publicKey.subarray(1, 33).toString("base64url"),
        y: keys.publicKey.subarray(33).toString("base64url"),
      },
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${encodedHeader}.${encodedClaims}`),
        { key: verificationKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });
});
