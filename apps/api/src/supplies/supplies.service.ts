import { Injectable } from "@nestjs/common";

import type { InAppReminderResult } from "../in-app-reminders/in-app-reminders.types.js";
import { SuppliesCommandService } from "./supplies-command.service.js";
import { SuppliesQueryService } from "./supplies-query.service.js";
import type {
  CreateSupplyCommand,
  CreateSupplyReminderCommand,
  DeleteSupplyCommand,
  GetSupplyQuery,
  ListSuppliesQuery,
  ListSuppliesResult,
  ListSupplyChecksQuery,
  ListSupplyChecksResult,
  SetSupplyCheckCommand,
  SupplyCheckResult,
  SupplyItem,
  UpdateSupplyCommand,
} from "./supplies.types.js";

@Injectable()
export class SuppliesService {
  constructor(
    private readonly queries: SuppliesQueryService,
    private readonly commands: SuppliesCommandService,
  ) {}

  list(query: ListSuppliesQuery): Promise<ListSuppliesResult> {
    return this.queries.list(query);
  }

  get(query: GetSupplyQuery): Promise<SupplyItem> {
    return this.queries.get(query);
  }

  create(command: CreateSupplyCommand): Promise<SupplyItem> {
    return this.commands.create(command);
  }

  createReminder(command: CreateSupplyReminderCommand): Promise<InAppReminderResult> {
    return this.commands.createReminder(command);
  }

  update(command: UpdateSupplyCommand): Promise<SupplyItem> {
    return this.commands.update(command);
  }

  delete(command: DeleteSupplyCommand): Promise<void> {
    return this.commands.delete(command);
  }

  setCheck(command: SetSupplyCheckCommand): Promise<SupplyCheckResult> {
    return this.commands.setCheck(command);
  }

  listChecks(query: ListSupplyChecksQuery): Promise<ListSupplyChecksResult> {
    return this.queries.listChecks(query);
  }
}
