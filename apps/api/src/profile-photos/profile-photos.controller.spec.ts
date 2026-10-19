import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants.js";
import type { FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { AuthenticatedCsrfGuard } from "../auth/authenticated-csrf.guard.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import type { AuthenticatedFastifyRequest } from "../auth/authenticated-request.js";
import {
  AccountProfilePhotoController,
  ProfilePhotoImageController,
} from "./profile-photos.controller.js";
import { ProfilePhotoNotFoundException } from "./profile-photo.errors.js";
import type { ProfilePhotosService } from "./profile-photos.service.js";

describe("photo HTTP authority boundary", () => {
  it("protects metadata/bytes by a session and every mutation by Origin/CSRF", () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AccountProfilePhotoController.prototype.getOwn),
    ).toEqual([AuthenticatedSessionGuard]);
    for (const method of ["updateOwn", "deleteOwn"] as const)
      expect(
        Reflect.getMetadata(GUARDS_METADATA, AccountProfilePhotoController.prototype[method]),
      ).toEqual([AuthenticatedCsrfGuard]);
    expect(Reflect.getMetadata(GUARDS_METADATA, ProfilePhotoImageController)).toEqual([
      AuthenticatedSessionGuard,
    ]);
  });
  it("does not show the previous class's teacher after a class switch", async () => {
    const getClassImage = vi.fn();
    const controller = new ProfilePhotoImageController({
      getClassImage,
    } as unknown as ProfilePhotosService);
    const request = {
      authenticatedSession: { userId: "31", sessionId: "session", currentClassId: "8" },
    } as AuthenticatedFastifyRequest;
    await expect(controller.getTeacher("7", request, {} as FastifyReply)).rejects.toBeInstanceOf(
      ProfilePhotoNotFoundException,
    );
    expect(getClassImage).not.toHaveBeenCalled();
  });
  it("serves only WebP bytes with no-store and nosniff headers", async () => {
    const bytes = Buffer.from("encoded");
    const controller = new ProfilePhotoImageController({
      getOwnImage: vi.fn(async () => bytes),
    } as unknown as ProfilePhotosService);
    const reply = { header: vi.fn(), type: vi.fn(), send: vi.fn() };
    for (const key of ["header", "type", "send"] as const) reply[key].mockReturnValue(reply);
    const request = {
      authenticatedSession: { userId: "31", sessionId: "session", currentClassId: "7" },
    } as AuthenticatedFastifyRequest;
    await controller.getOwn(request, reply as unknown as FastifyReply);
    expect(reply.header).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(reply.header).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
    expect(reply.type).toHaveBeenCalledWith("image/webp");
    expect(reply.send).toHaveBeenCalledWith(bytes);
  });
});
