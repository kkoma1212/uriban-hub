import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "kysely";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import {
  createMariaDbRowCodec,
  mariaDbDateBinding,
  mariaDbDateTime,
  mariaDbNullable,
} from "../common/database/mariadb-values.js";

export interface SignupMailTemplate {
  title: string;
  introduction: string;
  footer: string;
  button_label: string;
}

export const DEFAULT_SIGNUP_MAIL_TEMPLATE: Readonly<SignupMailTemplate> = {
  title: "회원가입 이메일 인증번호",
  introduction:
    "가입한 이메일로 로그인한 뒤 아래 6자리 인증번호를 입력해 주세요.",
  footer: "직접 요청하지 않았다면 이 메일은 무시해도 괜찮아요. 인증번호는 다른 사람에게 알려 주지 마세요.",
  button_label: "인증번호 입력하기",
};

@Injectable()
export class MailManagementService {
  private readonly maria: boolean;
  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    config: ConfigService<AppEnvironment, true>,
  ) {
    this.maria = config.get("DATABASE_ENGINE", { infer: true }) === "mariadb";
    if (this.maria)
      this.database = database.withPlugin(
        createMariaDbRowCodec({
          created_at: mariaDbDateTime,
          updated_at: mariaDbDateTime,
          completed_at: mariaDbNullable(mariaDbDateTime),
        }),
      );
  }

  private date(value: Date) {
    return this.maria ? mariaDbDateBinding(value) : value;
  }

  async template(): Promise<SignupMailTemplate> {
    return (
      (await this.database
        .selectFrom("mail_templates")
        .select(["title", "introduction", "footer", "button_label"])
        .where("key", "=", "signup_verification")
        .executeTakeFirst()) ?? { ...DEFAULT_SIGNUP_MAIL_TEMPLATE }
    );
  }

  async updateTemplate(template: SignupMailTemplate, adminId: string, requestId: string) {
    await this.database.transaction().execute(async (transaction) => {
      const value = {
        ...template,
        key: "signup_verification",
        updated_by_admin_account_id: adminId,
        updated_at: this.date(new Date()),
      };
      const insert = transaction.insertInto("mail_templates").values(value);
      if (this.maria) await insert.onDuplicateKeyUpdate(value).execute();
      else
        await insert.onConflict((conflict) => conflict.column("key").doUpdateSet(value)).execute();
      await transaction
        .insertInto("admin_operation_audit_logs")
        .values({
          action: "admin.system_state.updated",
          actor_admin_account_id: adminId,
          after_json: this.maria
            ? sql`${JSON.stringify({ template: "signup_verification" })}`
            : { template: "signup_verification" },
          before_json: null,
          reason: null,
          request_id: requestId,
          target_id: "mail_template.signup_verification",
          target_type: "system_state",
        })
        .execute();
    });
    return { saved: true };
  }

  async begin(recipient: string, subject: string): Promise<string> {
    const id = randomUUID();
    await this.database
      .insertInto("mail_delivery_logs")
      .values({
        id,
        recipient_email: recipient,
        subject,
        status: "pending",
        failure_code: null,
        completed_at: null,
      })
      .execute();
    return id;
  }

  async complete(
    id: string,
    status: "accepted" | "failed",
    failureCode: string | null,
  ): Promise<void> {
    await this.database
      .updateTable("mail_delivery_logs")
      .set({ status, failure_code: failureCode, completed_at: this.date(new Date()) })
      .where("id", "=", id)
      .where("status", "=", "pending")
      .execute();
  }

  async deliveries(email?: string) {
    let query = this.database
      .selectFrom("mail_delivery_logs")
      .select([
        "id",
        "recipient_email",
        "subject",
        "status",
        "failure_code",
        "created_at",
        "completed_at",
      ]);
    if (email) query = query.where("recipient_email", "=", email.trim().toLowerCase());
    return query.orderBy("created_at", "desc").orderBy("id", "desc").limit(100).execute();
  }
}
