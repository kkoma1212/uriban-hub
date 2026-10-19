import { Injectable } from "@nestjs/common";

import { ScheduleLinksService } from "./schedule-links.service.js";
import { SchedulesCommandService } from "./schedules-command.service.js";
import { SchedulesQueryService } from "./schedules-query.service.js";
import type {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCalendarQuery,
  GetScheduleLinksQuery,
  GetScheduleQuery,
  ListSchedulesQuery,
  ListSchedulesResult,
  ScheduleCalendarResult,
  ScheduleItem,
  ScheduleLinksResult,
  UpdateScheduleCommand,
  UpdateScheduleLinksCommand,
} from "./schedules.types.js";

@Injectable()
export class SchedulesService {
  constructor(
    private readonly queries: SchedulesQueryService,
    private readonly commands: SchedulesCommandService,
    private readonly links: ScheduleLinksService,
  ) {}

  list(query: ListSchedulesQuery): Promise<ListSchedulesResult> {
    return this.queries.list(query);
  }

  calendar(query: GetScheduleCalendarQuery): Promise<ScheduleCalendarResult> {
    return this.queries.calendar(query);
  }

  get(query: GetScheduleQuery): Promise<ScheduleItem> {
    return this.queries.get(query);
  }

  create(command: CreateScheduleCommand): Promise<ScheduleItem> {
    return this.commands.create(command);
  }

  update(command: UpdateScheduleCommand): Promise<ScheduleItem> {
    return this.commands.update(command);
  }

  delete(command: DeleteScheduleCommand): Promise<void> {
    return this.commands.delete(command);
  }

  getLinks(query: GetScheduleLinksQuery): Promise<ScheduleLinksResult> {
    return this.links.get(query);
  }

  replaceLinks(command: UpdateScheduleLinksCommand): Promise<ScheduleLinksResult> {
    return this.links.replace(command);
  }
}
