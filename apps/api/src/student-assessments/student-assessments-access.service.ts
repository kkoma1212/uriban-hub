import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { DB } from "@classhub/db";
import type { Kysely, Transaction } from "kysely";

import { hasApprovedAccountAccess } from "../auth/account-access-policy.js";
import { EmailNotVerifiedException, UnauthenticatedException } from "../auth/auth.errors.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import {
  assessmentDatabaseEngine,
  assessmentMariaDbRowCodec,
} from "./student-assessments.database.js";
import { StudentAssessmentRoleInsufficientException } from "./student-assessments.errors.js";

type AssessmentDatabase = Kysely<DB> | Transaction<DB>;

@Injectable()
export class StudentAssessmentsAccessService {
  private readonly engine: "postgres" | "mariadb";

  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
  ) {
    this.engine = assessmentDatabaseEngine(config);
    if (this.engine === "mariadb") this.database = database.withPlugin(assessmentMariaDbRowCodec);
  }

  assertStudent(actorUserId: string): Promise<void> {
    return this.assertStudentWith(this.database, actorUserId, false);
  }

  assertLockedStudent(transaction: Transaction<DB>, actorUserId: string): Promise<void> {
    return this.assertStudentWith(
      this.engine === "mariadb" ? transaction.withPlugin(assessmentMariaDbRowCodec) : transaction,
      actorUserId,
      true,
    );
  }

  private async assertStudentWith(
    database: AssessmentDatabase,
    actorUserId: string,
    lock: boolean,
  ): Promise<void> {
    let accountQuery = database
      .selectFrom("users")
      .select(["deleted_at", "email_verified_at", "is_active", "signup_approved_at", "signup_role"])
      .where("id", "=", actorUserId);
    if (lock) accountQuery = accountQuery.forUpdate();
    const account = await accountQuery.executeTakeFirst();
    if (account === undefined || !account.is_active || account.deleted_at !== null) {
      throw new UnauthenticatedException();
    }
    if (!hasApprovedAccountAccess(account)) throw new EmailNotVerifiedException();

    const membershipQuery = database
      .selectFrom("class_members as member")
      .innerJoin("classes as class", "class.id", "member.class_id")
      .select("member.id")
      .where("member.user_id", "=", actorUserId)
      .where("member.role", "=", "student")
      .where("member.status", "=", "approved")
      .where("class.status", "=", "active");
    // MariaDB has no FOR UPDATE OF. Keep the class check in a non-locking
    // subquery so only the user's membership is locked, as on PostgreSQL.
    const membership =
      lock && this.engine === "mariadb"
        ? await database
            .selectFrom("class_members as member")
            .select("member.id")
            .where("member.user_id", "=", actorUserId)
            .where("member.role", "=", "student")
            .where("member.status", "=", "approved")
            .where((eb) =>
              eb.exists(
                eb
                  .selectFrom("classes as class")
                  .select("class.id")
                  .whereRef("class.id", "=", "member.class_id")
                  .where("class.status", "=", "active"),
              ),
            )
            .forUpdate()
            .executeTakeFirst()
        : await (lock ? membershipQuery.forUpdate("member") : membershipQuery).executeTakeFirst();
    if (membership === undefined) throw new StudentAssessmentRoleInsufficientException();
  }
}
