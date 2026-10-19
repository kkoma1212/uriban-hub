import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { AuthModule } from "../auth/auth.module.js";
import { MealsModule } from "../meals/meals.module.js";
import { UpdatesModule } from "../updates/updates.module.js";
import type { AppEnvironment } from "../config/environment.js";
import { HomeController } from "./home.controller.js";
import {
  HOME_ATTENDANCE_NOTIFICATIONS_ENABLED,
  HOME_ELECTIONS_ENABLED,
  HOME_POLLS_ENABLED,
  HomeService,
} from "./home.service.js";

@Module({
  imports: [AuthModule, MealsModule, UpdatesModule],
  controllers: [HomeController],
  providers: [
    {
      provide: HOME_ATTENDANCE_NOTIFICATIONS_ENABLED,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnvironment, true>): boolean =>
        config.get("ATTENDANCE_NOTIFICATIONS_ENABLED", { infer: true }),
    },
    {
      provide: HOME_POLLS_ENABLED,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnvironment, true>): boolean =>
        config.get("POLLS_ENABLED", { infer: true }),
    },
    {
      provide: HOME_ELECTIONS_ENABLED,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnvironment, true>): boolean =>
        config.get("ELECTIONS_ENABLED", { infer: true }),
    },
    HomeService,
  ],
  exports: [HomeService],
})
export class HomeModule {}
