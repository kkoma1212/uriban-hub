import { readFileSync, readdirSync } from "node:fs";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { ADMIN_ERROR_MESSAGES, adminError } from "./admin-error.js";

const adminSources = ["src/admin-management", "src/admin-accounts"].flatMap((dir) =>
  readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.includes(".spec."))
    .map((name) => readFileSync(`${dir}/${name}`, "utf8")),
);

describe("adminError", () => {
  it("sends a Korean message with the code while the exception message stays the code", () => {
    const error = adminError(ConflictException, "TERMS_VERSION_EXISTS");
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toBe("TERMS_VERSION_EXISTS");
    expect(error.getResponse()).toEqual({
      code: "TERMS_VERSION_EXISTS",
      message: "같은 종류·같은 버전의 문서가 이미 있어요. 버전 이름을 바꿔 주세요.",
    });
    expect(adminError(BadRequestException, "UNKNOWN_CODE").getResponse()).toMatchObject({
      code: "UNKNOWN_CODE",
      message: expect.stringMatching(/[가-힣]/u),
    });
  });

  it("has a Korean message for every code the admin services throw", () => {
    const thrown = new Set(
      adminSources.flatMap((source) =>
        [...source.matchAll(/adminError\(\s*\w+,\s*"([A-Z0-9_]+)"\s*\)/gu)].map(
          (match) => match[1] ?? "",
        ),
      ),
    );
    expect(thrown.size).toBeGreaterThan(20);
    expect([...thrown].filter((code) => ADMIN_ERROR_MESSAGES[code] === undefined)).toEqual([]);
    // 관리자 서비스가 다시 코드만 던지면(화면에 영문 코드·'요청 형식' 문구) 잡는다.
    const codeOnly = adminSources.flatMap((source) =>
      [...source.matchAll(/new (?:BadRequest|Conflict|NotFound)Exception\("([A-Z0-9_]+)"\)/gu)].map(
        (match) => match[1],
      ),
    );
    expect(codeOnly).toEqual([]);
  });
});
