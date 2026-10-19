import type { ClassHubDatabase } from "../../database/database.module.js";
import type {
  MailDeliveryStatus,
  MembershipMailStatus,
  NotificationMailer,
} from "../../mail/notification-mailer.js";
import { MembersService } from "../members.service.js";
import type {
  ApproveMemberCommand,
  ApproveMemberResult,
  GetMemberProfileResult,
  ListMembersResult,
  MemberTransitionCommand,
  MemberTransitionResult,
  UpdateMemberProfileCommand,
  UpdateMemberProfileResult,
} from "../members.types.js";
import {
  allowMemberRejoinMariaDb,
  approveMemberMariaDb,
  rejectMemberMariaDb,
  removeMemberMariaDb,
} from "./member-management.js";
import {
  getMemberProfileMariaDb,
  listMembersMariaDb,
  updateMemberProfileMariaDb,
} from "./member-profile.js";

/** Uses the existing guards, request metadata and response shapes without adding retries. */
export class MariaDbMembersService extends MembersService {
  constructor(
    private readonly mariaDatabase: ClassHubDatabase,
    notifications?: NotificationMailer,
  ) {
    super(mariaDatabase, notifications);
  }

  override list(actorUserId: string, statusFilter?: string): Promise<ListMembersResult> {
    return listMembersMariaDb(this.mariaDatabase, actorUserId, statusFilter);
  }

  override getProfile(actorUserId: string, memberId: string): Promise<GetMemberProfileResult> {
    return getMemberProfileMariaDb(this.mariaDatabase, actorUserId, memberId);
  }

  override async approve(command: ApproveMemberCommand): Promise<ApproveMemberResult> {
    const result = await approveMemberMariaDb(this.mariaDatabase, command);
    return this.notifications === undefined
      ? result
      : {
          ...result,
          email_delivery_status: await this.sendCommittedStatus(command.memberId, "approved"),
        };
  }

  override updateProfile(command: UpdateMemberProfileCommand): Promise<UpdateMemberProfileResult> {
    return updateMemberProfileMariaDb(this.mariaDatabase, command);
  }

  override async reject(command: MemberTransitionCommand): Promise<MemberTransitionResult> {
    const result = await rejectMemberMariaDb(this.mariaDatabase, command);
    return this.notifications === undefined
      ? result
      : {
          ...result,
          email_delivery_status: await this.sendCommittedStatus(command.memberId, "rejected"),
        };
  }

  override async remove(command: MemberTransitionCommand): Promise<MemberTransitionResult> {
    const result = await removeMemberMariaDb(this.mariaDatabase, command);
    return this.notifications === undefined
      ? result
      : {
          ...result,
          email_delivery_status: await this.sendCommittedStatus(command.memberId, "removed"),
        };
  }

  override allowRejoin(command: MemberTransitionCommand): Promise<MemberTransitionResult> {
    return allowMemberRejoinMariaDb(this.mariaDatabase, command);
  }

  private async sendCommittedStatus(
    memberId: string,
    status: MembershipMailStatus,
  ): Promise<MailDeliveryStatus> {
    try {
      const details = await this.mariaDatabase
        .selectFrom("class_members as member")
        .innerJoin("classes as class", "class.id", "member.class_id")
        .innerJoin("users as account", "account.id", "member.user_id")
        .select(["class.name as className", "account.email_normalized as email"])
        .where("member.id", "=", memberId)
        .where("account.is_active", "=", true)
        .where("account.deleted_at", "is", null)
        .executeTakeFirst();
      return await this.sendStatusEmail(details, status);
    } catch {
      return "failed";
    }
  }
}
