import type { DB } from "@classhub/db";
import type { ColumnType, Kysely } from "kysely";

type Time = ColumnType<Date, Date | string, Date | string>;
export type AdminPasskeyTables = {
  admin_passkeys: {
    credential_id: string;
    admin_account_id: string;
    public_key: Buffer;
    user_handle: string;
    signature_counter: number;
    transports_json: string;
    device_type: string;
    backed_up: boolean;
    label: string;
    created_at: Time;
    used_at: Time | null;
    revoked_at: Time | null;
  };
  admin_recovery_codes: {
    id: string;
    admin_account_id: string;
    code_hash: Buffer;
    created_at: Time;
    used_at: Time | null;
    revoked_at: Time | null;
  };
  admin_webauthn_challenges: {
    id: string;
    admin_account_id: string;
    binding_hash: Buffer;
    purpose: string;
    challenge: string;
    user_handle: string | null;
    expires_at: Time;
    consumed_at: Time | null;
    created_at: Time;
  };
  admin_mfa_stepups: {
    session_id: string;
    method: string;
    verified_at: Time;
  };
};
export type AdminFactorDatabase = Kysely<DB & AdminPasskeyTables>;
export const adminFactorDatabase = (database: Kysely<DB>): AdminFactorDatabase =>
  database.withTables<AdminPasskeyTables>();
