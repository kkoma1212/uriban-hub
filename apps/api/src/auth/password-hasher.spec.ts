import { describe, expect, it } from "vitest";
import { argon2 } from "node:crypto";

import { hashPassword, passwordNeedsRehash, verifyPassword } from "./password-hasher.js";

async function storedHash(memory: number, passes: number, parallelism = 1): Promise<string> {
  const nonce = Buffer.alloc(16, 17);
  const tag = await new Promise<Buffer>((resolve, reject) =>
    argon2(
      "argon2id",
      {
        memory,
        passes,
        parallelism,
        nonce,
        message: "legacy stored credential",
        tagLength: 32,
      },
      (error, result) => (error === null ? resolve(result) : reject(error)),
    ),
  );
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${nonce.toString("base64").replaceAll("=", "")}$${tag.toString("base64").replaceAll("=", "")}`;
}

describe("password hasher", () => {
  it("uses the fixed Argon2id parameters and verifies only the correct password", async () => {
    const hash = await hashPassword("classhub123");

    expect(hash).toMatch(
      /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/u,
    );
    await expect(verifyPassword("classhub123", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password1", hash)).resolves.toBe(false);
  });

  it("rejects malformed hashes without throwing", async () => {
    await expect(verifyPassword("classhub123", "not-a-password-hash")).resolves.toBe(false);
  });

  it("verifies stored work factors and standard PHC base64 while identifying only safe upgrades", async () => {
    const older = await storedHash(8192, 1);
    await expect(verifyPassword("legacy stored credential", older)).resolves.toBe(true);
    await expect(verifyPassword("wrong credential", older)).resolves.toBe(false);
    expect(passwordNeedsRehash(older)).toBe(true);
    const stronger = await storedHash(65536, 4, 2);
    await expect(verifyPassword("legacy stored credential", stronger)).resolves.toBe(true);
    expect(passwordNeedsRehash(stronger)).toBe(false);
    expect(passwordNeedsRehash(await hashPassword("current credential"))).toBe(false);
  });

  it.each([
    "m=999999,t=3,p=1",
    "m=65536,t=9,p=1",
    "m=65536,t=3,p=9",
    "m=0,t=3,p=1",
    "m=65536,t=3,t=3",
  ])("rejects unsafe or ambiguous stored parameters %s", async (parameters) => {
    const hash = `$argon2id$v=19$${parameters}$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(32).toString("base64url")}`;
    await expect(verifyPassword("anything", hash)).resolves.toBe(false);
    expect(passwordNeedsRehash(hash)).toBe(false);
  });
});
