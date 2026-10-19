import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { MealsAccessService } from "./meals-access.service.js";
import { MealsController } from "./meals.controller.js";
import { MealsService } from "./meals.service.js";
import { NeisMealsService } from "./neis-meals.service.js";

@Module({
  imports: [AuthModule],
  controllers: [MealsController],
  providers: [MealsAccessService, MealsService, NeisMealsService],
  exports: [MealsService],
})
export class MealsModule {}
