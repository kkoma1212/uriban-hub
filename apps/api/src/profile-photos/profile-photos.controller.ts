import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { FastifyReply } from "fastify";
import { AuthenticatedCsrfGuard } from "../auth/authenticated-csrf.guard.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { ProfilePhotoNotFoundException } from "./profile-photo.errors.js";
import { UpdateProfilePhotoRequestDto } from "./profile-photo.dto.js";
import { ProfilePhotosService } from "./profile-photos.service.js";

@ApiTags("profile-photos")
@Controller("account/profile-photo")
export class AccountProfilePhotoController {
  constructor(private readonly photos: ProfilePhotosService) {}
  @Get()
  @UseGuards(AuthenticatedSessionGuard)
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "내 프로필 사진과 사진 입력 한도" })
  getOwn(@Req() request: AuthenticatedFastifyRequest) {
    return this.photos.getOwn(getAuthenticatedSession(request));
  }

  @Put()
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @Header("Cache-Control", "no-store")
  @ApiBody({ type: UpdateProfilePhotoRequestDto })
  @ApiOperation({ summary: "내 프로필 사진 변경" })
  @ApiResponse({
    status: 200,
    description: "원본·메타데이터를 보관하지 않고 256px WebP 사진으로 교체",
  })
  updateOwn(
    @Body() body: UpdateProfilePhotoRequestDto,
    @Req() request: AuthenticatedFastifyRequest,
  ) {
    return this.photos.updateOwn(getAuthenticatedSession(request), body.image_base64);
  }

  @Delete()
  @HttpCode(200)
  @UseGuards(AuthenticatedCsrfGuard)
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "내 프로필 사진 삭제" })
  deleteOwn(@Req() request: AuthenticatedFastifyRequest) {
    return this.photos.deleteOwn(getAuthenticatedSession(request));
  }
}

@ApiTags("profile-photos")
@Controller("profile-photos")
@UseGuards(AuthenticatedSessionGuard)
export class ProfilePhotoImageController {
  constructor(private readonly photos: ProfilePhotosService) {}

  @Get("me")
  @ApiProduces("image/webp")
  async getOwn(@Req() request: AuthenticatedFastifyRequest, @Res() reply: FastifyReply) {
    return this.send(reply, await this.photos.getOwnImage(getAuthenticatedSession(request)));
  }

  @Get("members/:memberId")
  @ApiProduces("image/webp")
  async getMember(
    @Param("memberId") memberId: string,
    @Req() request: AuthenticatedFastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.send(
      reply,
      await this.photos.getClassImage(getAuthenticatedSession(request), { memberId }),
    );
  }

  @Get("current-class-teacher")
  @ApiProduces("image/webp")
  @ApiQuery({ name: "class_id", required: true, type: String })
  async getTeacher(
    @Query("class_id") classId: string,
    @Req() request: AuthenticatedFastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const session = getAuthenticatedSession(request);
    if (classId !== session.currentClassId) throw new ProfilePhotoNotFoundException();
    return this.send(reply, await this.photos.getClassImage(session, { teacher: true }));
  }

  private send(reply: FastifyReply, bytes: Buffer) {
    return reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .type("image/webp")
      .send(bytes);
  }
}
