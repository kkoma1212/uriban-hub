import { Injectable } from "@nestjs/common";

import type { InAppReminderResult } from "../in-app-reminders/in-app-reminders.types.js";
import { NoticesCommandService } from "./notices-command.service.js";
import { NoticesQueryService } from "./notices-query.service.js";
import type {
  ConfirmNoticeCommand,
  CreateNoticeCommand,
  CreateNoticeReminderCommand,
  DeleteNoticeCommand,
  GetNoticeQuery,
  ListNoticeConfirmationsQuery,
  ListNoticeConfirmationsResult,
  ListNoticesQuery,
  ListNoticesResult,
  NoticeConfirmationResult,
  NoticeItem,
  UpdateNoticeCommand,
} from "./notices.types.js";

@Injectable()
export class NoticesService {
  constructor(
    private readonly queries: NoticesQueryService,
    private readonly commands: NoticesCommandService,
  ) {}

  list(query: ListNoticesQuery): Promise<ListNoticesResult> {
    return this.queries.list(query);
  }

  get(query: GetNoticeQuery): Promise<NoticeItem> {
    return this.queries.get(query);
  }

  create(command: CreateNoticeCommand): Promise<NoticeItem> {
    return this.commands.create(command);
  }

  createReminder(command: CreateNoticeReminderCommand): Promise<InAppReminderResult> {
    return this.commands.createReminder(command);
  }

  update(command: UpdateNoticeCommand): Promise<NoticeItem> {
    return this.commands.update(command);
  }

  delete(command: DeleteNoticeCommand): Promise<void> {
    return this.commands.delete(command);
  }

  confirm(command: ConfirmNoticeCommand): Promise<NoticeConfirmationResult> {
    return this.commands.confirm(command);
  }

  listConfirmations(query: ListNoticeConfirmationsQuery): Promise<ListNoticeConfirmationsResult> {
    return this.queries.listConfirmations(query);
  }
}
