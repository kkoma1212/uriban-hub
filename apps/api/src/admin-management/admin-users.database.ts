import type { DB } from "@classhub/db";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { sql, type Transaction } from "kysely";

import { mariaDbId, mariaDbTimestamp } from "../common/database/mariadb-values.js";
import { adminError } from "./admin-error.js";

/** The existing caller transaction retains user lock, session cleanup and required audit. */
export async function setMariaDbAdminUserStatus(
  transaction: Transaction<DB>,
  id: string,
  active: boolean,
  updatedAt: Date,
): Promise<void> {
  const userId = mariaDbId(id);
  const timestamp = mariaDbTimestamp(updatedAt);
  try {
    await sql`CALL set_admin_user_status(${userId},${active},${timestamp})`.execute(transaction);
  } catch (error) {
    // Translate only this protected CALL's explicit business rejections. Preserve
    // privilege/invariant/deadlock/connection failures for whole-transaction rollback.
    if (
      typeof error === "object" &&
      error !== null &&
      Object.getOwnPropertyDescriptor(error, "sqlState")?.value === "45000"
    ) {
      switch (Object.getOwnPropertyDescriptor(error, "errno")?.value) {
        case 32002:
          throw adminError(NotFoundException, "USER_NOT_FOUND");
        case 32003:
          throw new BadRequestException({
            code: "ADMIN_USER_STATUS_UNCHANGED",
            message: "이미 선택한 계정 상태입니다. 변경할 상태를 선택해 주세요.",
          });
        case 32004:
          throw adminError(ConflictException, "ADMIN_ACTIVE_TEACHER_TRANSFER_REQUIRED");
      }
    }
    throw error;
  }
}
