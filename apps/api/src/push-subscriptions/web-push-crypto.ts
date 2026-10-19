import {
  createECDH,
  createCipheriv,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";

/*
 * 웹 푸시 메시지 암호화(RFC 8291, aes128gcm)와 VAPID 서명(RFC 8292).
 * MPL-2.0인 web-push 패키지는 라이선스 허용 목록에 없어, Node 기본 암호 기능으로 구현한다.
 * 정확성은 RFC 8291 부록 A의 고정 입력·정답 암호문으로 검증한다(web-push-crypto.spec.ts).
 */

const RECORD_SIZE = 4096;
const P256_PUBLIC_KEY_BYTES = 65;
const P256_PRIVATE_KEY_BYTES = 32;
const AUTH_SECRET_BYTES = 16;
const SALT_BYTES = 16;
// 한 레코드에 담기는 최대 평문: 레코드 크기 - 헤더 없는 GCM 태그(16) - 구분 바이트(1).
export const MAX_PUSH_PLAINTEXT_BYTES = RECORD_SIZE - 16 - 1;
const VAPID_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;

export interface VapidKeys {
  publicKey: Buffer;
  privateKey: Buffer;
}

export function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new Error("Invalid base64url value.");
  return Buffer.from(value, "base64url");
}

export function isP256PublicKey(key: Buffer): boolean {
  return key.length === P256_PUBLIC_KEY_BYTES && key[0] === 0x04;
}

export function isAuthSecret(secret: Buffer): boolean {
  return secret.length === AUTH_SECRET_BYTES;
}

/** 설정된 VAPID 키 쌍이 형식에 맞고 공개키가 비밀키에서 나온 것인지 확인한다. */
export function parseVapidKeys(publicKeyText: string, privateKeyText: string): VapidKeys {
  const publicKey = decodeBase64Url(publicKeyText);
  const privateKey = decodeBase64Url(privateKeyText);
  if (!isP256PublicKey(publicKey) || privateKey.length !== P256_PRIVATE_KEY_BYTES) {
    throw new Error("VAPID keys must be an uncompressed P-256 public key and a 32-byte secret.");
  }
  const derived = createECDH("prime256v1");
  derived.setPrivateKey(privateKey);
  if (!derived.getPublicKey().equals(publicKey)) {
    throw new Error("VAPID public key does not match the private key.");
  }
  return { publicKey, privateKey };
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
}

export interface EncryptPushPayloadInput {
  plaintext: Buffer;
  userAgentPublicKey: Buffer;
  authSecret: Buffer;
  /** 테스트에서만 고정값을 넣는다. 운영은 메시지마다 새 임시 키를 만든다. */
  applicationServerPrivateKey?: Buffer;
  salt?: Buffer;
}

/** RFC 8291 한 레코드 aes128gcm 본문(헤더 포함)을 만든다. */
export function encryptPushPayload(input: EncryptPushPayloadInput): Buffer {
  const { plaintext, userAgentPublicKey, authSecret } = input;
  if (!isP256PublicKey(userAgentPublicKey) || !isAuthSecret(authSecret)) {
    throw new Error("Invalid push subscription keys.");
  }
  if (plaintext.length > MAX_PUSH_PLAINTEXT_BYTES) {
    throw new Error("Push payload is too large.");
  }
  const salt = input.salt ?? randomBytes(SALT_BYTES);
  if (salt.length !== SALT_BYTES) throw new Error("Invalid push salt.");

  const applicationServer = createECDH("prime256v1");
  if (input.applicationServerPrivateKey === undefined) applicationServer.generateKeys();
  else applicationServer.setPrivateKey(input.applicationServerPrivateKey);
  const applicationServerPublicKey = applicationServer.getPublicKey();
  const ecdhSecret = applicationServer.computeSecret(userAgentPublicKey);

  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "ascii"),
    userAgentPublicKey,
    applicationServerPublicKey,
  ]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const contentEncryptionKey = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);

  const cipher = createCipheriv("aes-128-gcm", contentEncryptionKey, nonce);
  // 0x02: 마지막 레코드 구분자(RFC 8188). 여분 패딩은 넣지 않는다.
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(SALT_BYTES + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, SALT_BYTES);
  header.writeUInt8(applicationServerPublicKey.length, SALT_BYTES + 4);
  return Buffer.concat([header, applicationServerPublicKey, ciphertext]);
}

function vapidSigningKey(keys: VapidKeys): KeyObject {
  return createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey.toString("base64url"),
      x: keys.publicKey.subarray(1, 33).toString("base64url"),
      y: keys.publicKey.subarray(33, 65).toString("base64url"),
    },
  });
}

/** RFC 8292 Authorization 헤더 값. 토큰 대상(aud)은 푸시 서비스의 origin이다. */
export function vapidAuthorization(
  endpoint: URL,
  subject: string,
  keys: VapidKeys,
  nowSeconds: number,
): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({
    aud: endpoint.origin,
    exp: nowSeconds + VAPID_TOKEN_LIFETIME_SECONDS,
    sub: subject,
  })}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: vapidSigningKey(keys),
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${signingInput}.${signature.toString("base64url")}, k=${keys.publicKey.toString("base64url")}`;
}
