export const LEGACY_PASSWORD_INPUT_VERSION = "legacy_exact_v0";
export const NFC_PASSWORD_INPUT_VERSION = "nfc_v1";

export type PasswordInputVersion =
  typeof LEGACY_PASSWORD_INPUT_VERSION | typeof NFC_PASSWORD_INPUT_VERSION;

export function passwordForVerification(rawPassword: string, inputVersion: string): string | null {
  if (inputVersion === LEGACY_PASSWORD_INPUT_VERSION) return rawPassword;
  if (inputVersion === NFC_PASSWORD_INPUT_VERSION) return rawPassword.normalize("NFC");
  return null;
}
