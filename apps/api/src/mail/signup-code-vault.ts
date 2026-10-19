import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

function key(secret: string): Buffer {
  return createHmac("sha256", secret).update("classhub:signup-code-vault:v1").digest();
}

export function encryptSignupCode(
  code: string,
  secret: string,
  email: string,
  role: string,
): string {
  if (!/^[0-9]{6}$/u.test(code)) throw new Error("Invalid signup code.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  cipher.setAAD(Buffer.from(JSON.stringify([email, role])));
  const encrypted = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

export function decryptSignupCode(
  value: string,
  secret: string,
  email: string,
  role: string,
): string {
  const packed = Buffer.from(value, "base64url");
  if (packed.length !== 34) throw new Error("Invalid encrypted signup code.");
  const decipher = createDecipheriv("aes-256-gcm", key(secret), packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  decipher.setAAD(Buffer.from(JSON.stringify([email, role])));
  const code = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString(
    "utf8",
  );
  if (!/^[0-9]{6}$/u.test(code)) throw new Error("Invalid decrypted signup code.");
  return code;
}
