import type { DB } from "@classhub/db";
import type { ColumnType, Kysely } from "kysely";
import { createAuthMariaRowCodec } from "../mariadb/auth-persistence.js";
type Time = ColumnType<Date, Date | string, Date | string>;
export type SocialTables = {
  social_identities: {
    identity_id: string;
    user_id: string;
    provider: string;
    issuer: string;
    subject: string;
    created_at: Time;
    used_at: Time | null;
  };
  social_oauth_flows: {
    flow_id: string;
    provider: string;
    stage: string;
    state_hash: Buffer;
    browser_hash: Buffer;
    encrypted_payload: string | null;
    created_at: Time;
    expires_at: Time;
    consumed_at: Time | null;
  };
};
export function socialDatabase(database: Kysely<DB>, maria: boolean) {
  const extended = database.withoutPlugins().withTables<SocialTables>();
  return maria ? extended.withPlugin(createAuthMariaRowCodec()) : extended;
}
// An explicit unusable credential marker, never a generated or shared password. The existing
// password verifier rejects non-Argon2 encodings. A verified password reset can set a real hash.
export const SOCIAL_ONLY_PASSWORD = "!classhub-social-only:v1";
