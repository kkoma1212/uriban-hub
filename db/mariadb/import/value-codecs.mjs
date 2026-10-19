import { Buffer } from "node:buffer";
import { isIP } from "node:net";

export function importFailure(coordinate) {
  const error = new Error(`PG_MARIADB_IMPORT_REJECTED:${coordinate}`);
  error.code = "PG_MARIADB_IMPORT_REJECTED";
  throw error;
}
const requireValue = (condition, coordinate) => {
  if (!condition) importFailure(coordinate);
};

function text(value, contract, coordinate) {
  requireValue(typeof value === "string" && value.isWellFormed(), `${coordinate}.text`);
  requireValue(!value.includes("\0"), `${coordinate}.nul`);
  if (contract.charset === "ascii")
    for (const character of value)
      requireValue(character.codePointAt(0) <= 127, `${coordinate}.ascii`);
  if (contract.max_characters !== null)
    requireValue([...value].length <= contract.max_characters, `${coordinate}.character_length`);
  if (contract.max_bytes !== null)
    requireValue(
      Buffer.byteLength(value, "utf8") <= contract.max_bytes,
      `${coordinate}.byte_length`,
    );
  return value;
}

function date(value, coordinate) {
  requireValue(/^[1-9]\d{3}-\d{2}-\d{2}$/u.test(value), `${coordinate}.date_format`);
  const [year, month, day] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  requireValue(
    month >= 1 && month <= 12 && day >= 1 && day <= monthDays[month - 1],
    `${coordinate}.date_range`,
  );
  return value;
}

/** Validate JSON grammar without creating numeric values or rewriting any text. */
export function assertLosslessJson(value, coordinate = "value.json") {
  requireValue(typeof value === "string" && value.isWellFormed(), coordinate);
  let cursor = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/u.test(value[cursor] ?? "x")) cursor++;
  };
  const reject = () => importFailure(coordinate);
  function string() {
    if (value[cursor++] !== '"') reject();
    while (cursor < value.length) {
      const character = value[cursor++];
      if (character === '"') return;
      if (character.charCodeAt(0) < 32) reject();
      if (character !== "\\") continue;
      const escaped = value[cursor++];
      if ('"\\/bfnrt'.includes(escaped ?? "!")) continue;
      if (escaped !== "u" || !/^[a-fA-F0-9]{4}$/u.test(value.slice(cursor, cursor + 4))) reject();
      const unit = Number.parseInt(value.slice(cursor, cursor + 4), 16);
      cursor += 4;
      if (unit >= 0xdc00 && unit <= 0xdfff) reject();
      if (unit >= 0xd800 && unit <= 0xdbff) {
        if (
          value.slice(cursor, cursor + 2) !== "\\u" ||
          !/^[a-fA-F0-9]{4}$/u.test(value.slice(cursor + 2, cursor + 6))
        )
          reject();
        const low = Number.parseInt(value.slice(cursor + 2, cursor + 6), 16);
        if (low < 0xdc00 || low > 0xdfff) reject();
        cursor += 6;
      }
    }
    reject();
  }
  function item(depth) {
    if (depth > 512) reject();
    whitespace();
    const character = value[cursor];
    if (character === '"') return string();
    if (character === "{" || character === "[") {
      const object = character === "{",
        close = object ? "}" : "]";
      cursor++;
      whitespace();
      if (value[cursor] === close) {
        cursor++;
        return;
      }
      while (cursor < value.length) {
        if (object) {
          whitespace();
          string();
          whitespace();
          if (value[cursor++] !== ":") reject();
        }
        item(depth + 1);
        whitespace();
        if (value[cursor] === close) {
          cursor++;
          return;
        }
        if (value[cursor++] !== ",") reject();
      }
      reject();
    }
    const atom = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(
      value.slice(cursor),
    );
    if (!atom) reject();
    cursor += atom[0].length;
  }
  item(0);
  whitespace();
  if (cursor !== value.length) reject();
  return value;
}

/** Input is exclusively PostgreSQL's explicit text/hex projection, never JS Date/number. */
export function encodePostgresImportValue(column, value) {
  const coordinate = `row.${column.table}.${column.name}`;
  if (value === null) {
    requireValue(column.source.nullable && column.target.nullable, `${coordinate}.nullability`);
    return null;
  }
  requireValue(typeof value === "string", `${coordinate}.wire_type`);
  const target = column.target;
  switch (column.codec) {
    case "signed_integer": {
      requireValue(/^(?:0|-?[1-9]\d*)$/u.test(value), `${coordinate}.integer_format`);
      const integer = BigInt(value);
      requireValue(
        integer >= BigInt(target.minimum) && integer <= BigInt(target.maximum),
        `${coordinate}.integer_range`,
      );
      return value;
    }
    case "boolean":
      requireValue(value === "true" || value === "false", `${coordinate}.boolean`);
      return value === "true" ? 1 : 0;
    case "bytea_hex": {
      requireValue(/^(?:[0-9a-f]{2})*$/u.test(value), `${coordinate}.hex`);
      const size = value.length / 2;
      requireValue(size <= target.max_bytes, `${coordinate}.byte_length`);
      return Buffer.from(value, "hex");
    }
    case "uuid":
      requireValue(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value),
        `${coordinate}.uuid`,
      );
      return value;
    case "utc_datetime6":
      requireValue(
        /^[1-9]\d{3}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}$/u.test(value),
        `${coordinate}.utc_datetime6`,
      );
      date(value.slice(0, 10), coordinate);
      return value;
    case "date":
      return date(value, coordinate);
    case "time0":
      requireValue(
        /^(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d|24:00:00)$/u.test(value),
        `${coordinate}.time0`,
      );
      return value;
    case "inet_host": {
      const match = /^([^/]+)\/(32|128)$/u.exec(value);
      requireValue(match, `${coordinate}.inet_host_mask`);
      const family = isIP(match[1]);
      requireValue(
        family !== 0 && match[2] === (family === 4 ? "32" : "128"),
        `${coordinate}.inet_host_mask`,
      );
      return text(match[1], target, coordinate);
    }
    case "json_raw":
      return assertLosslessJson(text(value, target, coordinate), `${coordinate}.json`);
    case "text":
      return text(value, target, coordinate);
    default:
      importFailure(`${coordinate}.codec`);
  }
}
