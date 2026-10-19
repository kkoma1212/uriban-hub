import type { DB } from "@classhub/db";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Transaction } from "kysely";

import type { AppEnvironment } from "../config/environment.js";
import type { ContentAudienceDto } from "./content-audiences.dto.js";
import {
  InvalidContentAudienceException,
  SelectedContentAudienceDisabledException,
} from "./content-audiences.errors.js";

export type ContentAudienceMode = "all_snapshot" | "legacy_class" | "selected_snapshot";
export type ContentAudienceWriteMode = "all" | "selected";

export interface NormalizedContentAudience {
  memberIds: string[];
  mode: ContentAudienceWriteMode;
  storedMode: Exclude<ContentAudienceMode, "legacy_class">;
}

const MAX_DATABASE_ID = 9_223_372_036_854_775_807n;

function compareDatabaseIds(left: string, right: string): number {
  const leftId = BigInt(left);
  const rightId = BigInt(right);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function isDatabaseId(value: string): boolean {
  if (!/^[1-9][0-9]*$/u.test(value)) return false;
  try {
    return BigInt(value) <= MAX_DATABASE_ID;
  } catch {
    return false;
  }
}

export function normalizeContentAudience(
  audience: ContentAudienceDto | undefined,
): NormalizedContentAudience {
  if (audience === undefined || audience.mode === "all") {
    if (audience?.member_ids !== undefined) throw new InvalidContentAudienceException();
    return { memberIds: [], mode: "all", storedMode: "all_snapshot" };
  }

  const memberIds = [...new Set(audience.member_ids ?? [])];
  if (
    memberIds.length === 0 ||
    memberIds.length > 60 ||
    memberIds.some((memberId) => !isDatabaseId(memberId))
  ) {
    throw new InvalidContentAudienceException();
  }
  memberIds.sort(compareDatabaseIds);
  return { memberIds, mode: "selected", storedMode: "selected_snapshot" };
}

@Injectable()
export class ContentAudiencesService {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  selectedAudienceEnabled(): boolean {
    return this.config.get("CONTENT_SELECTED_AUDIENCE_ENABLED", { infer: true });
  }

  async resolveRecipientIds(
    transaction: Transaction<DB>,
    classId: string,
    audience: NormalizedContentAudience,
  ): Promise<string[]> {
    if (audience.mode === "selected" && !this.selectedAudienceEnabled()) {
      throw new SelectedContentAudienceDisabledException();
    }

    let query = transaction
      .selectFrom("class_members as audience_member")
      .innerJoin("users as audience_account", "audience_account.id", "audience_member.user_id")
      .select("audience_member.id")
      .where("audience_member.class_id", "=", classId)
      .where("audience_member.role", "=", "student")
      .where("audience_member.status", "=", "approved")
      .where("audience_account.is_active", "=", true)
      .where("audience_account.deleted_at", "is", null);

    if (audience.mode === "selected") {
      query = query.where("audience_member.id", "in", audience.memberIds);
    }

    const rows = await query.orderBy("audience_member.id", "asc").execute();
    const memberIds = rows.map((row) => row.id);
    if (audience.mode === "selected" && memberIds.length !== audience.memberIds.length) {
      throw new InvalidContentAudienceException();
    }
    return memberIds;
  }
}
