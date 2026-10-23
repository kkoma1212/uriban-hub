import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { AuthModule } from "../auth/auth.module.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { NOTIFICATION_MAILER, type NotificationMailer } from "../mail/notification-mailer.js";
import { MemberPhotoPresenceReader } from "../profile-photos/member-photo-presence.js";
import { MariaDbMembersService } from "./mariadb/members.service.js";
import { MemberBirthDateReader } from "./member-birth-dates.js";
import { MembersController } from "./members.controller.js";
import { MembersService } from "./members.service.js";

export function createMembersService(
  database: ClassHubDatabase,
  config: ConfigService<AppEnvironment, true>,
  notifications?: NotificationMailer,
): MembersService {
  const engine = config.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
  if (engine === "mariadb") return new MariaDbMembersService(database, notifications);
  if (engine === "postgres") return new MembersService(database, notifications);
  throw new Error("Unsupported database engine");
}

@Module({
  imports: [AuthModule],
  controllers: [MembersController],
  providers: [
    {
      provide: MembersService,
      inject: [DATABASE, ConfigService, NOTIFICATION_MAILER],
      useFactory: createMembersService,
    },
    MemberBirthDateReader,
    MemberPhotoPresenceReader,
  ],
  exports: [MembersService],
})
export class MembersModule {}
