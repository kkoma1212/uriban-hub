import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "kysely";

import { ERROR_CODES } from "../common/errors/error-codes.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { parseAllowedPushEndpoint } from "./push-endpoint-policy.js";
import { decodeBase64Url, isAuthSecret, isP256PublicKey } from "./web-push-crypto.js";

// 한 계정이 여러 기기를 쓰는 경우를 허용하되, 위조한 주소로 행을 무한히 늘리지 못하게 막는다.
export const MAX_SUBSCRIPTIONS_PER_USER = 10;
const MARIADB_DUPLICATE_ENTRY = 1062;

export class PushEndpointNotAllowedException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: "이 브라우저의 알림 주소는 지원하지 않습니다.",
    });
  }
}

export interface SavePushSubscriptionCommand {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

@Injectable()
export class PushSubscriptionsService {
  private readonly mariaDb: boolean;
  private readonly publicKey: string;

  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    config: ConfigService<AppEnvironment, true>,
  ) {
    const engine = config.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
    if (engine !== "postgres" && engine !== "mariadb")
      throw new Error("Unsupported database engine");
    this.mariaDb = engine === "mariadb";
    const publicKey = config.get("WEB_PUSH_VAPID_PUBLIC_KEY", { infer: true });
    if (!publicKey) throw new Error("WEB_PUSH_VAPID_PUBLIC_KEY is required for web push.");
    this.publicKey = publicKey;
  }

  config(): { public_key: string } {
    return { public_key: this.publicKey };
  }

  /** 같은 브라우저 주소가 이미 있으면 지금 로그인한 계정으로 주인을 바꾼다. */
  async save(command: SavePushSubscriptionCommand): Promise<void> {
    if (
      parseAllowedPushEndpoint(command.endpoint) === null ||
      !isP256PublicKey(decodeBase64Url(command.p256dh)) ||
      !isAuthSecret(decodeBase64Url(command.auth))
    ) {
      throw new PushEndpointNotAllowedException();
    }
    const values = {
      auth_secret: command.auth,
      endpoint: command.endpoint,
      p256dh: command.p256dh,
      user_id: command.userId,
    };
    const now = this.mariaDb ? sql<Date>`UTC_TIMESTAMP(6)` : sql<Date>`clock_timestamp()`;
    await this.database.transaction().execute(async (transaction) => {
      const update = {
        auth_secret: command.auth,
        p256dh: command.p256dh,
        updated_at: now,
        user_id: command.userId,
      };
      if (this.mariaDb) {
        // MariaDB의 ON DUPLICATE KEY UPDATE는 삽입 열 전체(endpoint 포함)에 UPDATE 권한을
        // 요구한다. endpoint 수정 권한을 주지 않으려고 수정 → 삽입 → (동시 삽입 시) 재수정한다.
        const updateExisting = () =>
          transaction
            .updateTable("push_subscriptions")
            .set(update)
            .where("endpoint", "=", command.endpoint)
            .executeTakeFirst();
        if (Number((await updateExisting()).numUpdatedRows) === 0) {
          try {
            await transaction.insertInto("push_subscriptions").values(values).execute();
          } catch (error) {
            if ((error as { errno?: number }).errno !== MARIADB_DUPLICATE_ENTRY) throw error;
            await updateExisting();
          }
        }
      } else {
        await transaction
          .insertInto("push_subscriptions")
          .values(values)
          .onConflict((conflict) => conflict.column("endpoint").doUpdateSet(update))
          .execute();
      }

      const overflow = await transaction
        .selectFrom("push_subscriptions")
        .select("id")
        .where("user_id", "=", command.userId)
        .orderBy("updated_at", "desc")
        .orderBy("id", "desc")
        .limit(1_000)
        .offset(MAX_SUBSCRIPTIONS_PER_USER)
        .execute();
      if (overflow.length > 0) {
        await transaction
          .deleteFrom("push_subscriptions")
          .where(
            "id",
            "in",
            overflow.map(({ id }) => id),
          )
          .where("user_id", "=", command.userId)
          .execute();
      }
    });
  }

  /** 본인 구독만 지운다. 없으면 조용히 끝낸다(여러 번 눌러도 같은 결과). */
  async remove(userId: string, endpoint: string): Promise<void> {
    await this.database
      .deleteFrom("push_subscriptions")
      .where("endpoint", "=", endpoint)
      .where("user_id", "=", userId)
      .execute();
  }
}
