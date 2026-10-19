import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { DatabaseModule } from "../database/database.module.js";
import {
  AccountProfilePhotoController,
  ProfilePhotoImageController,
} from "./profile-photos.controller.js";
import { ProfilePhotoImageService } from "./profile-photo-image.service.js";
import { ProfilePhotosService } from "./profile-photos.service.js";

// Registered by AppModule only when PROFILE_PHOTOS_ENABLED=true (requires ledger 96-97 installed).
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [AccountProfilePhotoController, ProfilePhotoImageController],
  providers: [ProfilePhotoImageService, ProfilePhotosService],
})
export class ProfilePhotosModule {}
