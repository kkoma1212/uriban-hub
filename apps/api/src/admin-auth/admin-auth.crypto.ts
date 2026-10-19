import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_PERIOD_SECONDS = 30;

export interface EncryptedTotpSecret {
  authTag: Buffer;
  ciphertext: Buffer;
  iv: Buffer;
}

function encryptionKey(rawKey: string): Buffer {
  const key = Buffer.from(rawKey, "base64url");
  if (key.length !== 32) throw new Error("관리자 MFA 암호화 키는 32바이트여야 합니다.");
  return key;
}

function totpAdditionalData(adminAccountId: string, keyVersion: string): Buffer {
  return Buffer.from(
    JSON.stringify(["classhub-admin-totp", 1, adminAccountId, keyVersion]),
    "utf8",
  );
}

export function encodeBase32(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(input: string): Buffer {
  if (!/^[A-Z2-7]+$/u.test(input)) throw new TypeError("TOTP secret is not canonical base32.");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of input) {
    const index = BASE32_ALPHABET.indexOf(character);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) {
    throw new TypeError("TOTP secret has non-zero base32 padding bits.");
  }
  return Buffer.from(output);
}

export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

export function encryptTotpSecret(
  secret: Buffer,
  rawKey: string,
  keyVersion: string,
  adminAccountId: string,
): EncryptedTotpSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(rawKey), iv);
  cipher.setAAD(totpAdditionalData(adminAccountId, keyVersion));
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return { authTag: cipher.getAuthTag(), ciphertext, iv };
}

export function decryptTotpSecret(
  encrypted: EncryptedTotpSecret,
  rawKey: string,
  keyVersion: string,
  adminAccountId: string,
): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(rawKey), encrypted.iv);
  decipher.setAAD(totpAdditionalData(adminAccountId, keyVersion));
  decipher.setAuthTag(encrypted.authTag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
}

export function hotp(secret: Buffer, counter: bigint, digits = 6): string {
  if (counter < 0n) throw new RangeError("HOTP counter must not be negative.");
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new RangeError("HOTP digits must be between 6 and 8.");
  }
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totpCodeAt(secret: Buffer, timestampMs: number, digits = 6): string {
  const timestep = BigInt(Math.floor(timestampMs / 1_000 / TOTP_PERIOD_SECONDS));
  return hotp(secret, timestep, digits);
}

export function verifyTotp(
  secret: Buffer,
  rawCode: string,
  timestampMs: number,
  lastAcceptedTimestep: bigint | null,
): bigint | null {
  if (!/^\d{6}$/u.test(rawCode)) return null;
  const supplied = Buffer.from(rawCode, "ascii");
  const current = BigInt(Math.floor(timestampMs / 1_000 / TOTP_PERIOD_SECONDS));
  let match: bigint | null = null;

  for (const offset of [-1n, 0n, 1n]) {
    const timestep = current + offset;
    if (timestep < 0n) continue;
    const candidate = Buffer.from(hotp(secret, timestep), "ascii");
    const equal = timingSafeEqual(candidate, supplied);
    if (equal && (lastAcceptedTimestep === null || timestep > lastAcceptedTimestep)) {
      match = timestep;
    }
  }
  return match;
}

export function createOtpAuthUri(email: string, base32Secret: string): string {
  const issuer = "우리반 허브 관리자";
  const label = `${issuer}:${email}`;
  const query = new URLSearchParams({
    algorithm: "SHA1",
    digits: "6",
    issuer,
    period: String(TOTP_PERIOD_SECONDS),
    secret: base32Secret,
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${query.toString()}`;
}
