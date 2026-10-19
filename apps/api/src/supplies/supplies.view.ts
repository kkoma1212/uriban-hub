import { databaseDate } from "../common/date/kst-date.js";
import type { ContentAudienceMode } from "../content-audiences/content-audiences.service.js";
import type { SupplyCategory, SupplyCheckState, SupplyItem } from "./supplies.types.js";

export interface SupplyViewRow {
  audience_mode: string;
  category: string;
  content_revision: string;
  description: string | null;
  id: string;
  needed_on: Date | string;
  row_version: string;
  title: string;
}

export function supplyCheckState(
  isChecked: boolean | null,
  confirmedRevision: string | null,
  contentRevision: string,
): SupplyCheckState {
  if (isChecked !== true || confirmedRevision === null) return "unchecked";
  return confirmedRevision === contentRevision ? "checked" : "modified_unconfirmed";
}

export function supplyItemView(row: SupplyViewRow, checkState?: SupplyCheckState): SupplyItem {
  return {
    audience_mode: row.audience_mode as ContentAudienceMode,
    category: row.category as SupplyCategory,
    ...(checkState === undefined ? {} : { check_state: checkState }),
    content_revision: row.content_revision,
    description: row.description,
    id: row.id,
    needed_on: databaseDate(row.needed_on),
    row_version: row.row_version,
    title: row.title,
  };
}
