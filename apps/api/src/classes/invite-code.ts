import { randomInt } from "node:crypto";

const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const INVITE_LENGTH = 8;

export const INVITE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1_000;

export interface InviteCodeJson {
  [key: string]: string;
  code: string;
  created_at: string;
  expires_at: string;
  id: string;
  status: "active" | "expired";
}

export function generateInviteCode(): string {
  return Array.from(
    { length: INVITE_LENGTH },
    () => INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)]!,
  ).join("");
}

export function inviteView(
  invite: {
    code: string;
    created_at: Date;
    expires_at: Date;
    id: string;
  },
  now: Date,
): InviteCodeJson {
  return {
    code: invite.code,
    created_at: invite.created_at.toISOString(),
    expires_at: invite.expires_at.toISOString(),
    id: invite.id,
    status: invite.expires_at.getTime() > now.getTime() ? "active" : "expired",
  };
}
