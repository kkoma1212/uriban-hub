import { createDatabase, type DB } from "@classhub/db";
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "kysely";

import type { AppEnvironment } from "../config/environment.js";
import type { ClassHubDatabase } from "../database/database.module.js";

@Injectable()
export class LocalTestAdminDatabase implements OnApplicationShutdown, OnModuleInit {
  private database: ClassHubDatabase | undefined;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  get(): ClassHubDatabase {
    if (this.database === undefined) {
      throw new Error("The local test admin database is not available.");
    }
    return this.database;
  }

  async onModuleInit(): Promise<void> {
    const enabled = this.config.get("LOCAL_TEST_ADMIN_ENABLED", { infer: true });
    const environment = this.config.get("NODE_ENV", { infer: true });
    if (environment !== "development" || !enabled) return;

    const url = this.config.get("LOCAL_TEST_ADMIN_DATABASE_URL", { infer: true });
    if (url === undefined) {
      throw new Error("LOCAL_TEST_ADMIN_DATABASE_URL is not configured.");
    }

    const database = createDatabase<DB>(url);
    try {
      const identity = await sql<{ current_user: string }>`SELECT current_user`.execute(database);
      if (identity.rows[0]?.current_user !== "classhub_local_admin") {
        throw new Error("The local test admin database must use classhub_local_admin.");
      }
      this.database = database;
    } catch (error) {
      await database.destroy();
      throw error;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.database?.destroy();
  }
}
