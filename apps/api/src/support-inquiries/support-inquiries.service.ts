import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import {
  createMariaDbRowCodec,
  mariaDbDateTime,
  mariaDbNullable,
} from "../common/database/mariadb-values.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";

const createdFields = ["id", "status", "subject", "created_at", "updated_at"] as const;
const inquiryCodec = createMariaDbRowCodec({
  created_at: mariaDbDateTime,
  updated_at: mariaDbDateTime,
  responded_at: mariaDbNullable(mariaDbDateTime),
  resolved_at: mariaDbNullable(mariaDbDateTime),
});

@Injectable()
export class SupportInquiriesService {
  private readonly database: ClassHubDatabase;
  private readonly mariaDb: boolean;

  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    config: ConfigService<AppEnvironment, true>,
  ) {
    const engine = config.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
    if (engine !== "postgres" && engine !== "mariadb")
      throw new Error("Unsupported database engine");
    this.mariaDb = engine === "mariadb";
    this.database = this.mariaDb ? database.withPlugin(inquiryCodec) : database;
  }

  async create(userId: string, subject: string, body: string) {
    const values = { body: body.trim(), requester_user_id: userId, subject: subject.trim() };
    if (this.mariaDb) {
      return this.database.transaction().execute(async (transaction) => {
        // The inquiry UUID is known before insertion, so duplicate text cannot select another row.
        const id = randomUUID();
        await transaction
          .insertInto("admin_inquiries")
          .values({ id, ...values })
          .execute();
        const inquiry = await transaction
          .selectFrom("admin_inquiries")
          .select(createdFields)
          .where("id", "=", id)
          .where("requester_user_id", "=", userId)
          .executeTakeFirstOrThrow();
        return { inquiry };
      });
    }
    const inquiry = await this.database
      .insertInto("admin_inquiries")
      .values(values)
      .returning(createdFields)
      .executeTakeFirstOrThrow();
    return { inquiry };
  }

  async list(userId: string) {
    const inquiries = await this.database
      .selectFrom("admin_inquiries")
      .select([
        "id",
        "subject",
        "body",
        "status",
        "response",
        "responded_at",
        "created_at",
        "updated_at",
        "resolved_at",
      ])
      .where("requester_user_id", "=", userId)
      .orderBy("updated_at", "desc")
      .limit(100)
      .execute();
    return { inquiries };
  }
}
