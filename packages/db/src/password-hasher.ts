import { argon2, randomBytes, timingSafeEqual } from "node:crypto";
import { PasswordWorkLimiter } from "./password-work-limiter.js";

const MEMORY_KIB = 64 * 1024;
const PASSES = 3;
const PARALLELISM = 1;
const SALT_LENGTH = 16;
const TAG_LENGTH = 32;
const workLimiter = new PasswordWorkLimiter();

interface Parameters {
  memory: number;
  passes: number;
  parallelism: number;
  tagLength: number;
}
const currentParameters: Parameters = {
  memory: MEMORY_KIB,
  passes: PASSES,
  parallelism: PARALLELISM,
  tagLength: TAG_LENGTH,
};

function deriveKey(
  password: string,
  nonce: Buffer,
  parameters = currentParameters,
): Promise<Buffer> {
  return workLimiter.run(
    () =>
      new Promise((resolve, reject) => {
        argon2(
          "argon2id",
          {
            ...parameters,
            message: Buffer.from(password, "utf8"),
            nonce,
          },
          (error, derivedKey) => {
            if (error !== null) {
              reject(error);
              return;
            }

            resolve(derivedKey);
          },
        );
      }),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = await deriveKey(password, salt);

  return [
    "",
    "argon2id",
    "v=19",
    `m=${MEMORY_KIB},t=${PASSES},p=${PARALLELISM}`,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

function parseHash(encodedHash: string) {
  if (encodedHash.length > 256) return null;
  const match =
    /^\$argon2id\$v=19\$m=([1-9]\d{0,5}),t=([1-9]),p=([1-9])\$([A-Za-z0-9_+/-]+)\$([A-Za-z0-9_+/-]+)$/u.exec(
      encodedHash,
    );
  if (match === null) return null;
  const memory = Number(match[1]),
    passes = Number(match[2]),
    parallelism = Number(match[3]);
  if (memory < 8192 || memory > 131072 || passes > 6 || parallelism > 4) return null;
  const decode = (value: string): Buffer | null => {
    const bytes = Buffer.from(value, "base64url");
    return bytes.toString("base64url") === value.replaceAll("+", "-").replaceAll("/", "_")
      ? bytes
      : null;
  };
  const salt = decode(match[4]!),
    expected = decode(match[5]!);
  if (
    salt === null ||
    expected === null ||
    salt.length < 8 ||
    salt.length > 64 ||
    expected.length < 16 ||
    expected.length > 64
  )
    return null;
  return {
    salt,
    expected,
    parameters: { memory, passes, parallelism, tagLength: expected.length },
  };
}

export function passwordNeedsRehash(encodedHash: string): boolean {
  const parsed = parseHash(encodedHash);
  if (parsed === null) return false;
  const { memory, passes, parallelism, tagLength } = parsed.parameters;
  // Preserve hashes whose work factors or output are stronger than the current writer.
  return (
    memory <= MEMORY_KIB &&
    passes <= PASSES &&
    parallelism <= PARALLELISM &&
    tagLength <= TAG_LENGTH &&
    parsed.salt.length <= SALT_LENGTH &&
    (memory < MEMORY_KIB ||
      passes < PASSES ||
      tagLength < TAG_LENGTH ||
      parsed.salt.length < SALT_LENGTH)
  );
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const parsed = parseHash(encodedHash);
  if (parsed === null) return false;
  const actual = await deriveKey(password, parsed.salt, parsed.parameters);
  return timingSafeEqual(actual, parsed.expected);
}
