import type { ClassHubDatabase } from "../../database/database.module.js";
import { ClassesService } from "../classes.service.js";
import type {
  ArchiveCurrentClassCommand,
  ArchiveCurrentClassResult,
  CreateClassCommand,
  CreateClassResult,
  CurrentClassResult,
  CurrentInviteCodeResult,
  RotateInviteCodeCommand,
  RotateInviteCodeResult,
  UpdateCurrentClassCommand,
  UpdateCurrentClassResult,
} from "../classes.types.js";
import { archiveCurrentClassMariaDb } from "./archive-class.js";
import { createClassMariaDb } from "./create-class.js";
import { getCurrentClassMariaDb, updateCurrentClassMariaDb } from "./current-class.js";
import { getCurrentInviteCodeMariaDb, rotateInviteCodeMariaDb } from "./invite-code.js";

/** Uses the existing HTTP guards and result contracts with the reviewed MariaDB callers. */
export class MariaDbClassesService extends ClassesService {
  constructor(private readonly mariaDatabase: ClassHubDatabase) {
    super(mariaDatabase);
  }

  override create(command: CreateClassCommand): Promise<CreateClassResult> {
    return createClassMariaDb(this.mariaDatabase, command);
  }

  override archiveCurrent(command: ArchiveCurrentClassCommand): Promise<ArchiveCurrentClassResult> {
    return archiveCurrentClassMariaDb(this.mariaDatabase, command);
  }

  override getCurrent(userId: string): Promise<CurrentClassResult> {
    return getCurrentClassMariaDb(this.mariaDatabase, userId);
  }

  override updateCurrent(command: UpdateCurrentClassCommand): Promise<UpdateCurrentClassResult> {
    return updateCurrentClassMariaDb(this.mariaDatabase, command);
  }

  override getCurrentInviteCode(
    userId: string,
    now = new Date(),
  ): Promise<CurrentInviteCodeResult> {
    return getCurrentInviteCodeMariaDb(this.mariaDatabase, userId, now);
  }

  override rotateInviteCode(command: RotateInviteCodeCommand): Promise<RotateInviteCodeResult> {
    return rotateInviteCodeMariaDb(this.mariaDatabase, command);
  }
}
