import type { AuthConfig } from "../../auth/auth.types.js";
import type { RedisRateLimiter } from "../../common/rate-limit/redis-rate-limiter.js";
import type { ClassHubDatabase } from "../../database/database.module.js";
import type { NotificationMailer } from "../../mail/notification-mailer.js";
import { MembershipService } from "../membership.service.js";
import type {
  CreateMembershipRequestCommand,
  CreateMembershipRequestResult,
  OwnMembershipTransitionCommand,
  OwnMembershipTransitionResult,
} from "../membership.types.js";
import { cancelOwnMembershipMariaDb, leaveOwnMembershipMariaDb } from "./own-membership.js";
import {
  requestMembershipMariaDb,
  type MembershipRequestDependencies,
} from "./request-membership.js";

/** Keeps the existing HTTP contract and Redis policy with the reviewed MariaDB callers. */
export class MariaDbMembershipService extends MembershipService {
  private readonly requestDependencies: MembershipRequestDependencies;

  constructor(
    private readonly mariaDatabase: ClassHubDatabase,
    rateLimiter: RedisRateLimiter,
    authConfig: AuthConfig,
    notifications?: NotificationMailer,
  ) {
    super(mariaDatabase, rateLimiter, authConfig, notifications);
    this.requestDependencies = { rateLimiter, authConfig };
  }

  override async createRequest(
    command: CreateMembershipRequestCommand,
  ): Promise<CreateMembershipRequestResult> {
    const result = await requestMembershipMariaDb(
      this.mariaDatabase,
      command,
      this.requestDependencies,
    );
    if (this.notifications === undefined) return result;
    // The mutation has committed. Recipient lookup and SMTP cannot turn it into a retryable failure.
    try {
      const details = await this.mariaDatabase
        .selectFrom("class_members as member")
        .innerJoin("classes as class", "class.id", "member.class_id")
        .innerJoin("users as account", "account.id", "member.user_id")
        .select(["class.name as className", "account.email_normalized as email"])
        .where("member.id", "=", result.membership_id)
        .where("account.is_active", "=", true)
        .where("account.deleted_at", "is", null)
        .executeTakeFirst();
      return { ...result, ...(await this.sendRequestNotifications(result.class_id, details)) };
    } catch {
      return {
        ...result,
        email_delivery_status: "failed",
        teacher_notification_delivery_status: "failed",
      };
    }
  }

  override cancelCurrentRequest(
    command: OwnMembershipTransitionCommand,
  ): Promise<OwnMembershipTransitionResult> {
    return cancelOwnMembershipMariaDb(this.mariaDatabase, command);
  }

  override leaveCurrentMembership(
    command: OwnMembershipTransitionCommand,
  ): Promise<OwnMembershipTransitionResult> {
    return leaveOwnMembershipMariaDb(this.mariaDatabase, command);
  }
}
