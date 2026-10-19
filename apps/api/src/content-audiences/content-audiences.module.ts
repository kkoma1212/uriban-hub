import { Module } from "@nestjs/common";

import { ContentAudiencesService } from "./content-audiences.service.js";

@Module({
  providers: [ContentAudiencesService],
  exports: [ContentAudiencesService],
})
export class ContentAudiencesModule {}
