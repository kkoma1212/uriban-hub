export type SchoolKind = "elementary" | "high" | "middle";

export interface SchoolSeedItem {
  eduOfficeCode: string;
  eduOfficeName: string;
  homepageUrl?: string | null;
  phoneNumber?: string | null;
  regionName: string;
  roadAddress?: string | null;
  roadAddressDetail?: string | null;
  schoolCode: string;
  schoolKind: SchoolKind;
  schoolName: string;
}

export interface ParsedSchoolSeed {
  items: SchoolSeedItem[];
  schemaVersion: 1 | 2;
}

export class SchoolSeedValidationError extends Error {
  readonly code = "INVALID_SCHOOL_SEED";

  constructor(message: string) {
    super(message);
    this.name = "SchoolSeedValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  location: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    !actual.every((key, index) => key === sortedExpected[index])
  ) {
    throw new SchoolSeedValidationError(`${location}의 key 구성이 올바르지 않습니다.`);
  }
}

function requiredCode(value: unknown, pattern: RegExp, location: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new SchoolSeedValidationError(`${location} 형식이 올바르지 않습니다.`);
  }
  return value;
}

function normalizedText(value: unknown, location: string): string {
  if (typeof value !== "string") {
    throw new SchoolSeedValidationError(`${location}은 문자열이어야 합니다.`);
  }
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (length < 1 || length > 100) {
    throw new SchoolSeedValidationError(`${location}은 trim 후 1~100자여야 합니다.`);
  }
  return normalized;
}

function nullableText(value: unknown, maximum: number, location: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new SchoolSeedValidationError(`${location}은 문자열 또는 null이어야 합니다.`);
  }
  const normalized = value.trim();
  if (normalized === "") return null;
  const length = Array.from(normalized).length;
  if (length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new SchoolSeedValidationError(
      `${location}은 제어문자 없이 trim 후 1~${maximum}자여야 합니다.`,
    );
  }
  return normalized;
}

function nullablePhoneNumber(value: unknown, location: string): string | null {
  const normalized = nullableText(value, 50, location);
  if (normalized === null) return null;
  const digitCount = normalized.replace(/\D/gu, "").length;
  if (digitCount < 3 || digitCount > 20) {
    throw new SchoolSeedValidationError(`${location}의 숫자는 3~20자리여야 합니다.`);
  }
  return normalized;
}

function nullableHomepageUrl(value: unknown, location: string): string | null {
  const normalized = nullableText(value, 500, location);
  if (normalized === null) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/iu.test(normalized) ? normalized : `https://${normalized}`);
  } catch {
    throw new SchoolSeedValidationError(`${location}이 올바른 홈페이지 주소가 아닙니다.`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new SchoolSeedValidationError(`${location}은 안전한 HTTP(S) 주소여야 합니다.`);
  }
  if (Array.from(url.href).length > 500) {
    throw new SchoolSeedValidationError(`${location}은 정규화 후 500자를 초과할 수 없습니다.`);
  }
  return url.href;
}

function schoolKind(value: unknown, location: string): SchoolKind {
  if (value !== "elementary" && value !== "middle" && value !== "high") {
    throw new SchoolSeedValidationError(
      `${location}은 elementary, middle, high 중 하나여야 합니다.`,
    );
  }
  return value;
}

export function parseSchoolSeedJson(text: string): ParsedSchoolSeed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new SchoolSeedValidationError("학교 seed가 올바른 JSON이 아닙니다.");
  }
  if (!isRecord(parsed)) {
    throw new SchoolSeedValidationError("학교 seed 최상위 값은 객체여야 합니다.");
  }
  assertExactKeys(parsed, ["items", "schema_version"], "최상위 객체");
  if (
    (parsed.schema_version !== 1 && parsed.schema_version !== 2) ||
    !Number.isInteger(parsed.schema_version)
  ) {
    throw new SchoolSeedValidationError("schema_version은 정수 1 또는 2여야 합니다.");
  }
  const schemaVersion = parsed.schema_version;
  if (!Array.isArray(parsed.items) || parsed.items.length > 30_000) {
    throw new SchoolSeedValidationError("items는 최대 30,000개 배열이어야 합니다.");
  }

  const uniqueKeys = new Set<string>();
  const items = parsed.items.map((rawItem, index): SchoolSeedItem => {
    const location = `items[${index}]`;
    if (!isRecord(rawItem)) {
      throw new SchoolSeedValidationError(`${location}은 객체여야 합니다.`);
    }
    const version1Keys = [
      "edu_office_code",
      "edu_office_name",
      "region_name",
      "school_code",
      "school_kind",
      "school_name",
    ];
    assertExactKeys(
      rawItem,
      schemaVersion === 1
        ? version1Keys
        : [...version1Keys, "homepage_url", "phone_number", "road_address", "road_address_detail"],
      location,
    );

    const eduOfficeCode = requiredCode(
      rawItem.edu_office_code,
      /^[A-Z][0-9]{2}$/u,
      `${location}.edu_office_code`,
    );
    const schoolCode = requiredCode(rawItem.school_code, /^[0-9]{7}$/u, `${location}.school_code`);
    const key = `${eduOfficeCode}:${schoolCode}`;
    if (uniqueKeys.has(key)) {
      throw new SchoolSeedValidationError(`${location}에 중복 학교 key가 있습니다.`);
    }
    uniqueKeys.add(key);

    const base = {
      eduOfficeCode,
      eduOfficeName: normalizedText(rawItem.edu_office_name, `${location}.edu_office_name`),
      regionName: normalizedText(rawItem.region_name, `${location}.region_name`),
      schoolCode,
      schoolKind: schoolKind(rawItem.school_kind, `${location}.school_kind`),
      schoolName: normalizedText(rawItem.school_name, `${location}.school_name`),
    };
    return schemaVersion === 1
      ? base
      : {
          ...base,
          homepageUrl: nullableHomepageUrl(rawItem.homepage_url, `${location}.homepage_url`),
          phoneNumber: nullablePhoneNumber(rawItem.phone_number, `${location}.phone_number`),
          roadAddress: nullableText(rawItem.road_address, 200, `${location}.road_address`),
          roadAddressDetail: nullableText(
            rawItem.road_address_detail,
            200,
            `${location}.road_address_detail`,
          ),
        };
  });

  return { items, schemaVersion };
}
