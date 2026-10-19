/** The main environment/module entry remains unchanged until rollout is approved. */
export function profilePhotosEnabled(input: Record<string, unknown>): boolean {
  if (input.PROFILE_PHOTOS_ENABLED === undefined || input.PROFILE_PHOTOS_ENABLED === "false")
    return false;
  if (input.PROFILE_PHOTOS_ENABLED === "true") return true;
  throw new TypeError("PROFILE_PHOTOS_ENABLED must be true or false.");
}
