import "reflect-metadata";

import { ValidationPipe } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";

import { AttendanceMutationBodyDto } from "./attendance-notifications-command.dto.js";

function errors(values: Record<string, unknown>) {
  return validateSync(plainToInstance(AttendanceMutationBodyDto, values));
}

describe("attendance mutation DTO", () => {
  it.each([
    { expected_time: "00:00", notification_type: "late" },
    { expected_time: "23:59", notification_type: "early" },
    { expected_time: null, notification_type: "absent" },
  ])("accepts only the documented type/time combination", (body) => {
    expect(errors(body)).toHaveLength(0);
  });

  it.each([
    { notification_type: "late" },
    { expected_time: null, notification_type: "late" },
    { expected_time: "08:30", notification_type: "absent" },
    { expected_time: null, notification_type: "early" },
    { expected_time: "8:30", notification_type: "late" },
    { expected_time: "08:30:00", notification_type: "late" },
    { expected_time: "24:00", notification_type: "late" },
    { expected_time: "12:60", notification_type: "early" },
    { expected_time: null, notification_type: "vacation" },
  ])("rejects omitted, cross-type, or non-minute values", (body) => {
    expect(errors(body)).not.toHaveLength(0);
  });

  it("rejects free-reason and other unknown fields under the application pipe", async () => {
    const pipe = new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    });
    await expect(
      pipe.transform(
        { expected_time: null, notification_type: "absent", reason: "건강 문제" },
        { metatype: AttendanceMutationBodyDto, type: "body" },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
