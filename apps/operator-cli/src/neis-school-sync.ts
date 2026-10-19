import { createHash } from "node:crypto";

import {
  fetchNeisSchools,
  type NeisSchoolCatalog,
  type NeisSchoolQuery,
  NeisSchoolError,
  validateNeisSchoolQuery,
} from "./neis-school.js";
import {
  importSchoolSource,
  type ImportSchoolsResult,
  type LoadedSchoolSeed,
} from "./school-import.js";
import type { SchoolSeedItem } from "./school-seed.js";

const SOURCE_FILE_NAME = "neis:schoolInfo:nationwide";

type NeisSchoolFetcher = (query: NeisSchoolQuery) => Promise<NeisSchoolCatalog>;

export interface SyncNeisSchoolsInput {
  apiKey: string | undefined;
  dryRun?: boolean;
  fetchSchools?: NeisSchoolFetcher;
  operatorDatabaseUrl: string | undefined;
  operatorToken: string;
}

export interface SyncNeisSchoolsResult extends ImportSchoolsResult {
  blankedOptionalFieldCount: number;
  fetchedCount: number;
  ignoredInvalidIdentifierCount: number;
  ignoredUnsupportedCount: number;
  sourceCount: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizedSeedText(items: SchoolSeedItem[]): string {
  return JSON.stringify({
    items: items.map((item) => ({
      edu_office_code: item.eduOfficeCode,
      edu_office_name: item.eduOfficeName,
      homepage_url: item.homepageUrl ?? null,
      phone_number: item.phoneNumber ?? null,
      region_name: item.regionName,
      road_address: item.roadAddress ?? null,
      road_address_detail: item.roadAddressDetail ?? null,
      school_code: item.schoolCode,
      school_kind: item.schoolKind,
      school_name: item.schoolName,
    })),
    schema_version: 2,
  });
}

function sourceErrorCode(error: unknown): string | undefined {
  return error instanceof NeisSchoolError ? error.code : undefined;
}

export async function syncNeisSchools(input: SyncNeisSchoolsInput): Promise<SyncNeisSchoolsResult> {
  const query = validateNeisSchoolQuery({ apiKey: input.apiKey });
  let blankedOptionalFieldCount = 0;
  let fetchedCount = 0;
  let ignoredInvalidIdentifierCount = 0;
  let ignoredUnsupportedCount = 0;
  let sourceCount = 0;
  const result = await importSchoolSource({
    dryRun: input.dryRun ?? false,
    loadSource: async (): Promise<LoadedSchoolSeed> => {
      const catalog = await (input.fetchSchools ?? fetchNeisSchools)(query);
      blankedOptionalFieldCount = catalog.blankedOptionalFieldCount;
      fetchedCount = catalog.items.length;
      ignoredInvalidIdentifierCount = catalog.ignoredInvalidIdentifierCount;
      ignoredUnsupportedCount = catalog.ignoredUnsupportedCount;
      sourceCount = catalog.sourceCount;
      const text = normalizedSeedText(catalog.items);
      return {
        checksum: sha256(text),
        fileName: SOURCE_FILE_NAME,
        text,
      };
    },
    operatorDatabaseUrl: input.operatorDatabaseUrl,
    operatorToken: input.operatorToken,
    sourceErrorCode,
    sourceFailureIdentity: {
      checksum: sha256(SOURCE_FILE_NAME),
      fileName: SOURCE_FILE_NAME,
    },
  });
  return {
    ...result,
    blankedOptionalFieldCount,
    fetchedCount,
    ignoredInvalidIdentifierCount,
    ignoredUnsupportedCount,
    sourceCount,
  };
}
