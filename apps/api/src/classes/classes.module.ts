import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { AuthModule } from "../auth/auth.module.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { ClassesCollectionController, ClassesController } from "./classes.controller.js";
import { ClassesService } from "./classes.service.js";
import { MariaDbClassesService } from "./mariadb/classes.service.js";

export function createClassesService(
  database: ClassHubDatabase,
  config: ConfigService<AppEnvironment, true>,
): ClassesService {
  const engine = config.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
  if (engine === "mariadb") return new MariaDbClassesService(database);
  if (engine === "postgres") return new ClassesService(database);
  throw new Error("Unsupported database engine");
}

@Module({
  imports: [AuthModule],
  controllers: [ClassesCollectionController, ClassesController],
  providers: [
    {
      provide: ClassesService,
      inject: [DATABASE, ConfigService],
      useFactory: createClassesService,
    },
  ],
  exports: [ClassesService],
})
export class ClassesModule {}
