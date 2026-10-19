import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import {
  ageRouteForBirthDate,
  birthDateConflict,
  birthDateRejected,
  isAcceptableBirthDate,
} from "../auth/birth-date.js";
import { UnauthenticatedException } from "../auth/auth.errors.js";
import { databaseDate } from "../common/date/kst-date.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";

export interface AccountBirthDateResult {
  /** 생년월일 칸이 설치된 환경인지. false면 설정 화면에 입력란을 보이지 않는다. */
  available: boolean;
  birth_date: string | null;
  birthday_shared: boolean;
}

/**
 * 설정의 생년월일. 이미 가입한 계정이 비어 있는 생년월일을 한 번 채우고, 생일을 반에 알릴지 고른다.
 * 저장된 생년월일은 여기서 바꾸지 않는다 — 가입 때 정한 나이 경로(보호자 동의 여부)를 뒤집지 못하게.
 */
@Injectable()
export class AccountBirthDateService {
  private readonly installed: boolean;

  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Optional() @Inject(ConfigService) environment?: ConfigService<AppEnvironment, true>,
  ) {
    this.installed =
      environment?.get("USER_BIRTH_DATES_DATABASE_INSTALLED", { infer: true }) === true;
  }

  async read(userId: string): Promise<AccountBirthDateResult> {
    if (!this.installed) return { available: false, birth_date: null, birthday_shared: false };
    const row = await this.database
      .selectFrom("users")
      .select(["birth_date", "birthday_shared"])
      .where("id", "=", userId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (row === undefined) throw new UnauthenticatedException();
    return {
      available: true,
      birth_date: row.birth_date === null ? null : databaseDate(row.birth_date),
      birthday_shared: Boolean(row.birthday_shared),
    };
  }

  async update(
    userId: string,
    input: { birth_date?: string; birthday_shared?: boolean },
  ): Promise<AccountBirthDateResult> {
    if (!this.installed) throw birthDateConflict("생년월일을 받을 수 없는 환경이에요.");
    const now = new Date();
    await this.database.transaction().execute(async (transaction) => {
      const current = await transaction
        .selectFrom("users")
        .select(["birth_date", "birthday_shared"])
        .where("id", "=", userId)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (current === undefined) throw new UnauthenticatedException();
      const stored = current.birth_date === null ? null : databaseDate(current.birth_date);
      let birthDate = stored;
      if (input.birth_date !== undefined && input.birth_date !== stored) {
        if (stored !== null)
          throw birthDateConflict(
            "생년월일은 한 번만 입력할 수 있어요. 고치려면 운영자에게 문의해 주세요.",
          );
        if (!isAcceptableBirthDate(input.birth_date, now))
          throw birthDateRejected("생년월일을 확인해 주세요.");
        if (ageRouteForBirthDate(input.birth_date, now) === "guardian_consent") {
          // 만 14세 이상으로 가입한 계정이 14세 미만 생년월일을 넣으면 보호자 동의 없이 쓰게 된다.
          const overFourteen = await transaction
            .selectFrom("user_consents")
            .select("id")
            .where("user_id", "=", userId)
            .where("consent_type", "=", "age_over_14")
            .executeTakeFirst();
          if (overFourteen !== undefined)
            throw birthDateConflict(
              "만 14세 이상으로 가입한 계정이에요. 생년월일이 다르면 운영자에게 문의해 주세요.",
            );
        }
        birthDate = input.birth_date;
      }
      const shared = input.birthday_shared ?? Boolean(current.birthday_shared);
      if (shared && birthDate === null)
        throw birthDateRejected("생일을 알리려면 생년월일을 먼저 입력해 주세요.");
      await transaction
        .updateTable("users")
        .set({
          ...(birthDate !== stored && birthDate !== null ? { birth_date: birthDate } : {}),
          birthday_shared: shared,
        })
        .where("id", "=", userId)
        .execute();
    });
    return this.read(userId);
  }
}
