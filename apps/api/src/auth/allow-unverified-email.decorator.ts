import { SetMetadata } from "@nestjs/common";

export const ALLOW_UNVERIFIED_EMAIL = "classhub:allow-unverified-email";

export const AllowUnverifiedEmail = () => SetMetadata(ALLOW_UNVERIFIED_EMAIL, true);
