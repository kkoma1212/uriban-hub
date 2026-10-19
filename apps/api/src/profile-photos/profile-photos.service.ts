import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql, type Transaction } from "kysely";
import type { DB } from "@classhub/db";
import { AccountProfileBlockedException } from "../account/account.errors.js";
import { createMariaDbAccountRowCodec } from "../account/mariadb/account-row-codec.js";
import { hasApprovedAccountAccess } from "../auth/account-access-policy.js";
import { UnauthenticatedException } from "../auth/auth.errors.js";
import { AUTH_RATE_LIMITER } from "../auth/auth.tokens.js";
import { RateLimitedException } from "../common/rate-limit/rate-limit.errors.js";
import type { RedisRateLimiter } from "../common/rate-limit/redis-rate-limiter.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import {
  PROFILE_PHOTO_FORMATS,
  PROFILE_PHOTO_INPUT_PIXELS,
  PROFILE_PHOTO_STORED_BYTES,
  PROFILE_PHOTO_UPLOAD_BYTES,
} from "./profile-photo.constants.js";
import { ProfilePhotoNotFoundException } from "./profile-photo.errors.js";
import { ProfilePhotoImageService } from "./profile-photo-image.service.js";
import type {
  ClassPhotoTarget,
  ProfilePhotoActor,
  ProfilePhotoState,
} from "./profile-photo.types.js";

export function classProfilePhotoQuery(
  database: ClassHubDatabase,
  actor: ProfilePhotoActor,
  target: ClassPhotoTarget,
) {
  if (actor.currentClassId === null) throw new ProfilePhotoNotFoundException();
  let query = database
    .selectFrom("user_profile_photos as photo")
    .innerJoin("class_members as target", "target.user_id", "photo.user_id")
    .innerJoin("class_members as viewer", "viewer.class_id", "target.class_id")
    .innerJoin("classes as classroom", "classroom.id", "target.class_id")
    .innerJoin("users as target_account", "target_account.id", "target.user_id")
    .innerJoin("users as viewer_account", "viewer_account.id", "viewer.user_id")
    .leftJoin("teacher_profiles as target_teacher", "target_teacher.user_id", "target.user_id")
    .leftJoin("teacher_profiles as viewer_teacher", "viewer_teacher.user_id", "viewer.user_id")
    .select(["photo.image_bytes", "photo.photo_version"])
    .where("viewer.user_id", "=", actor.userId)
    .where("viewer.class_id", "=", actor.currentClassId)
    .where("viewer.status", "=", "approved")
    .where("target.status", "=", "approved")
    .where("classroom.status", "=", "active")
    .where("target_account.is_active", "=", true)
    .where("target_account.deleted_at", "is", null)
    .where("viewer_account.is_active", "=", true)
    .where("viewer_account.deleted_at", "is", null)
    .where((eb) =>
      eb.or([
        eb("target.role", "=", "student"),
        eb.and([
          eb("target.role", "=", "teacher"),
          eb("target_teacher.status", "=", "active"),
          eb("target_teacher.temporary_password_must_change", "=", false),
        ]),
      ]),
    )
    .where((eb) =>
      eb.or([
        eb("viewer.role", "=", "student"),
        eb.and([
          eb("viewer.role", "=", "teacher"),
          eb("viewer_teacher.status", "=", "active"),
          eb("viewer_teacher.temporary_password_must_change", "=", false),
        ]),
      ]),
    );
  if ("memberId" in target) {
    if (
      !/^[1-9][0-9]{0,18}$/u.test(target.memberId) ||
      BigInt(target.memberId) > 9223372036854775807n
    )
      throw new ProfilePhotoNotFoundException();
    query = query.where("target.id", "=", target.memberId);
  } else query = query.where("target.role", "=", "teacher");
  return query;
}

function state(version: string | null): ProfilePhotoState {
  return {
    enabled: true,
    photo:
      version === null
        ? null
        : {
            url: "/api/v1/profile-photos/me?v=" + encodeURIComponent(version),
            version,
            width: 256,
            height: 256,
            content_type: "image/webp",
          },
    limits: {
      upload_bytes: PROFILE_PHOTO_UPLOAD_BYTES,
      stored_bytes: PROFILE_PHOTO_STORED_BYTES,
      source_pixels: PROFILE_PHOTO_INPUT_PIXELS,
      formats: PROFILE_PHOTO_FORMATS,
    },
  };
}

@Injectable()
export class ProfilePhotosService {
  private readonly database: ClassHubDatabase;
  private readonly mariaDb: boolean;
  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    @Inject(ConfigService) environment: ConfigService<AppEnvironment, true>,
    @Inject(AUTH_RATE_LIMITER) private readonly rateLimiter: RedisRateLimiter,
    private readonly images: ProfilePhotoImageService,
  ) {
    this.mariaDb = environment.get("DATABASE_ENGINE", { infer: true }) === "mariadb";
    this.database = this.mariaDb ? database.withPlugin(createMariaDbAccountRowCodec()) : database;
  }

  async getOwn(actor: ProfilePhotoActor): Promise<ProfilePhotoState> {
    const row = await this.ownQuery(actor).select("photo.photo_version").executeTakeFirst();
    return state(row?.photo_version ?? null);
  }
  async getOwnImage(actor: ProfilePhotoActor): Promise<Buffer> {
    const row = await this.ownQuery(actor).select("photo.image_bytes").executeTakeFirst();
    if (row === undefined) throw new ProfilePhotoNotFoundException();
    return row.image_bytes;
  }
  async getClassImage(actor: ProfilePhotoActor, target: ClassPhotoTarget): Promise<Buffer> {
    const row = await classProfilePhotoQuery(this.database, actor, target).executeTakeFirst();
    if (row === undefined) throw new ProfilePhotoNotFoundException();
    return row.image_bytes;
  }
  async updateOwn(actor: ProfilePhotoActor, base64: string): Promise<ProfilePhotoState> {
    const limit = await this.rateLimiter.consume({
      key: "profile-photo:user:" + actor.userId,
      limit: 10,
      windowSeconds: 600,
    });
    if (!limit.allowed) throw new RateLimitedException(limit.retryAfterSeconds, limit);
    const imageBytes = await this.images.encode(base64);
    return this.database.transaction().execute(async (transaction) => {
      const now = await this.lockActor(transaction, actor);
      const previous = await transaction
        .selectFrom("user_profile_photos")
        .select(["image_bytes", "photo_version"])
        .where("user_id", "=", actor.userId)
        .executeTakeFirst();
      if (previous?.image_bytes.equals(imageBytes)) return state(previous.photo_version);
      const version = randomUUID();
      const values = { image_bytes: imageBytes, photo_version: version, updated_at: now };
      if (previous === undefined)
        await transaction
          .insertInto("user_profile_photos")
          .values({ user_id: actor.userId, ...values })
          .execute();
      else
        await transaction
          .updateTable("user_profile_photos")
          .set(values)
          .where("user_id", "=", actor.userId)
          .execute();
      return state(version);
    });
  }
  async deleteOwn(actor: ProfilePhotoActor): Promise<ProfilePhotoState> {
    return this.database.transaction().execute(async (transaction) => {
      await this.lockActor(transaction, actor);
      await transaction
        .deleteFrom("user_profile_photos")
        .where("user_id", "=", actor.userId)
        .execute();
      return state(null);
    });
  }
  private ownQuery(actor: ProfilePhotoActor) {
    return this.database
      .selectFrom("user_profile_photos as photo")
      .innerJoin("users as account", "account.id", "photo.user_id")
      .where("photo.user_id", "=", actor.userId)
      .where("account.is_active", "=", true)
      .where("account.deleted_at", "is", null);
  }
  private async lockActor(transaction: Transaction<DB>, actor: ProfilePhotoActor): Promise<Date> {
    // Match the established account lock order; this serializes photo writes with account deletion.
    const account = await transaction
      .selectFrom("users")
      .select(["deleted_at", "is_active", "email_verified_at", "signup_approved_at", "signup_role"])
      .where("id", "=", actor.userId)
      .forUpdate()
      .executeTakeFirst();
    if (
      account === undefined ||
      !account.is_active ||
      account.deleted_at !== null ||
      !hasApprovedAccountAccess(account)
    )
      throw new UnauthenticatedException();
    const profile = await transaction
      .selectFrom("teacher_profiles")
      .select(["status", "temporary_password_must_change"])
      .where("user_id", "=", actor.userId)
      .forUpdate()
      .executeTakeFirst();
    if (profile?.status === "revoked" || profile?.temporary_password_must_change === true)
      throw new AccountProfileBlockedException();
    const session = await transaction
      .selectFrom("sessions")
      .select(["expires_at", "revoked_at"])
      .where("id", "=", actor.sessionId)
      .where("user_id", "=", actor.userId)
      .forUpdate()
      .executeTakeFirst();
    const clock = await sql
      .raw<{ now: Date }>(
        this.mariaDb ? "SELECT UTC_TIMESTAMP(6) AS now" : "SELECT clock_timestamp() AS now",
      )
      .execute(transaction);
    const now = clock.rows[0]?.now;
    if (!(now instanceof Date) || Number.isNaN(now.getTime()))
      throw new Error("Database clock did not return a valid Date.");
    if (
      session === undefined ||
      session.revoked_at !== null ||
      session.expires_at.getTime() <= now.getTime()
    )
      throw new UnauthenticatedException();
    return now;
  }
}
