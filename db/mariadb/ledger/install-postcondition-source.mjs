import { createHash } from "node:crypto";

export function postconditionFailure(coordinate) {
  const error = new Error(`INSTALL_POSTCONDITION_FAILED:${coordinate}`);
  error.code = "INSTALL_POSTCONDITION_FAILED";
  throw error;
}
const requireCondition = (condition, coordinate) => {
  if (!condition) postconditionFailure(coordinate);
};
export const contractDigest = (value) => createHash("sha256").update(value).digest("hex");

/** Restrictive lexical handling for the pinned source grammar; never execute or translate SQL. */
export function sourceStatements(input) {
  const output = [];
  let part = "",
    delimiter = ";",
    quote = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i],
      next = input[i + 1];
    if (quote) {
      part += c;
      if (c === "\\" && quote !== "`") part += input[++i] ?? "";
      else if (c === quote) {
        if (next === quote) part += input[++i];
        else quote = null;
      }
      continue;
    }
    if (c === "#" || (c === "-" && next === "-" && /\s/u.test(input[i + 2] ?? "\n"))) {
      while (i < input.length && input[i] !== "\n") i++;
      part += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      requireCondition(!/^[!+]|^M!/u.test(input.slice(i + 2, i + 4)), "source.executable_comment");
      const end = input.indexOf("*/", i + 2);
      requireCondition(end !== -1 && !input.slice(i + 2, end).includes("/*"), "source.comment");
      part += " ";
      i = end + 1;
      continue;
    }
    if ((i === 0 || input[i - 1] === "\n") && /^DELIMITER\s/iu.test(input.slice(i))) {
      requireCondition(part.trim() === "", "source.delimiter_boundary");
      const command = /^DELIMITER\s+(\/\/|;)\s*(?:\r?\n|$)/iu.exec(input.slice(i));
      requireCondition(command, "source.delimiter");
      delimiter = command[1];
      i += command[0].length - 1;
      continue;
    }
    if (["'", '"', "`"].includes(c)) {
      quote = c;
      part += c;
      continue;
    }
    if (input.startsWith(delimiter, i)) {
      if (part.trim()) output.push(part.trim());
      part = "";
      i += delimiter.length - 1;
      continue;
    }
    part += c;
  }
  requireCondition(!quote && part.trim() === "", "source.unterminated_statement");
  return output;
}

function lexicalParts(input) {
  const output = [];
  for (let i = 0; i < input.length;) {
    if (/\s/u.test(input[i])) {
      i++;
      continue;
    }
    if (input[i] === "#" || (input.startsWith("--", i) && /\s/u.test(input[i + 2] ?? "\n"))) {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (input.startsWith("/*", i)) {
      requireCondition(
        !/^[!+]|^M!/u.test(input.slice(i + 2, i + 4)),
        "metadata.executable_comment",
      );
      const end = input.indexOf("*/", i + 2);
      requireCondition(end !== -1 && !input.slice(i + 2, end).includes("/*"), "metadata.comment");
      i = end + 2;
      continue;
    }
    const start = i,
      quote = input[i];
    if (["'", '"', "`"].includes(quote)) {
      let closed = false;
      for (i++; i < input.length; i++) {
        if (input[i] === "\\" && quote !== "`") {
          i++;
          continue;
        }
        if (input[i] === quote) {
          if (input[i + 1] === quote) {
            i++;
            continue;
          }
          i++;
          closed = true;
          break;
        }
      }
      requireCondition(closed, "metadata.unterminated_quote");
      output.push({ text: input.slice(start, i), start, end: i, literal: quote !== "`" });
      continue;
    }
    const word = /^(?:[a-z_][a-z0-9_]*|0x[a-f0-9]+|\d+(?:\.\d+)?|<>|<=|>=|!=|:=|\|\|)/iu.exec(
      input.slice(i),
    );
    i += word ? word[0].length : 1;
    output.push({ text: input.slice(start, i), start, end: i, literal: false });
  }
  return output;
}

function closingParenthesis(tokens, start) {
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index] === "(") depth++;
    if (tokens[index] === ")" && --depth === 0) return index;
  }
  return -1;
}
function singleBinaryOperand(tokens) {
  if (tokens.length === 1)
    return /^(?:[a-z_][a-z0-9_]*|\d+(?:\.\d+)?|'(?:[^']|'')*'|"(?:[^"]|"")*")$/u.test(tokens[0]);
  if (tokens[0] === "(") return closingParenthesis(tokens, 0) === tokens.length - 1;
  if (/^[a-z_][a-z0-9_]*$/u.test(tokens[0]) && tokens[1] === "(")
    return closingParenthesis(tokens, 1) === tokens.length - 1;
  return (
    tokens.length % 2 === 1 &&
    tokens.every((token, index) =>
      index % 2 === 0 ? /^[a-z_][a-z0-9_]*$/u.test(token) : token === ".",
    )
  );
}
/** MariaDB 11.4 emits unary BINARY as an unbounded CHAR/BINARY-charset cast.
 * Only a complete single operand is rewritten; operators and grouping remain intact.
 */
function mariaDbExpressionAliases(tokens) {
  const output = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] === "lcase" && tokens[index + 1] === "(" && tokens[index - 1] !== ".") {
      output.push("lower");
      continue;
    }
    if (tokens[index] === "cast" && tokens[index + 1] === "(") {
      const close = closingParenthesis(tokens, index + 1);
      if (close >= 0 && tokens.slice(close - 4, close).join(" ") === "as char charset binary") {
        const operand = tokens.slice(index + 2, close - 4);
        if (singleBinaryOperand(operand)) {
          output.push("binary", ...mariaDbExpressionAliases(operand));
          index = close;
          continue;
        }
      }
    }
    output.push(tokens[index]);
  }
  return output;
}

/** Normalize only documented lexical aliases; retain literals, operators and grouping. */
export function canonicalMetadataSql(input) {
  if (input === null || input === undefined) return null;
  let tokens = lexicalParts(String(input)).map((token) =>
    token.literal ? token.text : token.text.replaceAll("`", "").toLowerCase(),
  );
  while (tokens[0] === "(" && tokens.at(-1) === ")") {
    let depth = 0,
      wraps = true;
    for (let i = 0; i < tokens.length - 1; i++) {
      if (tokens[i] === "(") depth++;
      if (tokens[i] === ")") depth--;
      if (depth === 0) {
        wraps = false;
        break;
      }
    }
    if (!wraps) break;
    tokens = tokens.slice(1, -1);
  }
  return mariaDbExpressionAliases(tokens)
    .map((token) => (token === "true" ? "1" : token === "false" ? "0" : token))
    .join(" ");
}

/** The pinned UUID-v4 default's variant expression; & binds before | in MariaDB.
 * Token matching cannot touch quoted contents or accept a changed mask/random size.
 */
export function canonicalDefaultSql(input) {
  const canonical = canonicalMetadataSql(input);
  if (canonical === null) return null;
  const tokens = lexicalParts(canonical).map((token) => token.text);
  const from = "hex ( 8 | ( ord ( random_bytes ( 1 ) ) & 3 ) )".split(" ");
  const to = "hex ( 8 | ord ( random_bytes ( 1 ) ) & 3 )".split(" ");
  const output = [];
  for (let index = 0; index < tokens.length; index++) {
    if (from.every((token, offset) => tokens[index + offset] === token)) {
      output.push(...to);
      index += from.length - 1;
    } else output.push(tokens[index]);
  }
  return output.join(" ");
}

/** CHECK-only boolean structure: preserve SQL AND-before-OR precedence, BETWEEN's
 * internal AND, CASE bodies, scalar/function parentheses, literals and operand order.
 * MariaDB may omit redundant boolean grouping; never remove arbitrary parentheses.
 */
export function canonicalCheckSql(input) {
  const sql = canonicalMetadataSql(input);
  if (sql === null) return null;
  function parse(part) {
    while (part[0] === "(" && closingParenthesis(part, 0) === part.length - 1)
      part = part.slice(1, -1);
    if (part[0] === "case") {
      let depth = 0,
        caseDepth = 0;
      const markers = [];
      for (const [index, token] of part.entries()) {
        if (token === "(") depth++;
        if (token === ")") depth--;
        if (token === "case") caseDepth++;
        if (depth === 0 && caseDepth === 1 && ["when", "then", "else", "end"].includes(token))
          markers.push({ token, index });
        if (token === "end") caseDepth--;
      }
      if (markers.at(-1)?.token === "end" && markers.at(-1).index === part.length - 1) {
        const cases = [],
          first = markers[0];
        requireCondition(first?.token === "when", "metadata.case_when");
        let index = 0;
        for (; markers[index]?.token === "when"; index += 2) {
          const when = markers[index],
            then = markers[index + 1],
            next = markers[index + 2];
          requireCondition(then?.token === "then" && next, "metadata.case_then");
          cases.push([
            parse(part.slice(when.index + 1, then.index)),
            parse(part.slice(then.index + 1, next.index)),
          ]);
        }
        const tail = markers[index];
        requireCondition(
          tail?.token === "end" || (tail?.token === "else" && markers[index + 1]?.token === "end"),
          "metadata.case_end",
        );
        return {
          cases,
          operand: first.index === 1 ? null : parse(part.slice(1, first.index)),
          otherwise: tail.token === "else" ? parse(part.slice(tail.index + 1, -1)) : null,
        };
      }
    }
    for (const operator of ["or", "and"]) {
      let depth = 0,
        caseDepth = 0,
        between = false,
        start = 0;
      const pieces = [];
      for (let index = 0; index < part.length; index++) {
        const token = part[index];
        if (token === "(") depth++;
        if (token === ")") depth--;
        if (depth !== 0) continue;
        if (token === "case") caseDepth++;
        if (token === "end" && caseDepth > 0) caseDepth--;
        if (caseDepth !== 0) continue;
        if (token === "between") between = true;
        if (token === "and" && between) {
          between = false;
          continue;
        }
        if (token === operator) {
          pieces.push(part.slice(start, index));
          start = index + 1;
        }
      }
      if (pieces.length) {
        pieces.push(part.slice(start));
        const children = pieces
          .map(parse)
          .flatMap((node) => (node.operator === operator ? node.children : [node]));
        return { operator, children };
      }
    }
    // The attested mode excludes HIGH_NOT_PRECEDENCE: bare NOT binds below comparison.
    if (part[0] === "not") return { negated: parse(part.slice(1)) };
    if (part[0] === "!" && part[1] === "(" && closingParenthesis(part, 1) === part.length - 1)
      return { negated: parse(part.slice(2, -1)) };
    let depth = 0;
    for (let index = 0; index < part.length - 1; index++) {
      if (part[index] === "(") depth++;
      if (part[index] === ")") depth--;
      if (depth === 0 && part[index] === "not" && part[index + 1] === "regexp") {
        const left = part.slice(0, index),
          right = part.slice(index + 2);
        if (singleBinaryOperand(left) && singleBinaryOperand(right))
          return { negated: { text: [...left, "regexp", ...right].join(" ") } };
      }
    }
    depth = 0;
    let caseDepth = 0;
    const comparisons = [];
    for (const [index, token] of part.entries()) {
      if (token === "(") depth++;
      if (token === ")") depth--;
      if (depth !== 0) continue;
      if (token === "case") caseDepth++;
      if (token === "end" && caseDepth > 0) caseDepth--;
      if (caseDepth === 0 && ["=", "<>", "!=", "<", ">", "<=", ">="].includes(token))
        comparisons.push(index);
    }
    if (comparisons.length === 1) {
      const index = comparisons[0];
      return {
        comparison: part[index],
        left: parse(part.slice(0, index)),
        right: parse(part.slice(index + 1)),
      };
    }
    return { text: part.join(" ") };
  }
  const render = (node) =>
    node.cases
      ? `( case${node.operand ? ` ${render(node.operand)}` : ""}${node.cases.map(([condition, result]) => ` when ${render(condition)} then ${render(result)}`).join("")}${node.otherwise ? ` else ${render(node.otherwise)}` : ""} end )`
      : node.operator
        ? `( ${node.children.map(render).join(` ${node.operator} `)} )`
        : node.negated
          ? `not ( ${render(node.negated)} )`
          : node.comparison
            ? `( ${render(node.left)} ${node.comparison} ${render(node.right)} )`
            : node.text;
  return render(parse(lexicalParts(sql).map((token) => token.text)));
}
function splitTop(input) {
  const tokens = lexicalParts(input),
    result = [];
  let depth = 0,
    start = 0;
  for (const token of tokens) {
    if (token.text === "(") depth++;
    if (token.text === ")") depth--;
    requireCondition(depth >= 0, "source.parenthesis");
    if (token.text === "," && depth === 0) {
      result.push(input.slice(start, token.start).trim());
      start = token.end;
    }
  }
  requireCondition(depth === 0, "source.parenthesis");
  result.push(input.slice(start).trim());
  return result;
}
function enclosed(input, open = input.indexOf("(")) {
  requireCondition(open >= 0, "source.missing_parenthesis");
  let depth = 0;
  for (const token of lexicalParts(input.slice(open))) {
    if (token.text === "(") depth++;
    if (token.text === ")" && --depth === 0)
      return { body: input.slice(open + 1, open + token.start), end: open + token.end };
  }
  postconditionFailure("source.unclosed_parenthesis");
}
const identifiers = (input) =>
  splitTop(input).map((value) => {
    const match = /^`?([a-z_][a-z0-9_]*)`?(?:\s*\((\d+)\))?(?:\s+(ASC|DESC))?$/iu.exec(value);
    requireCondition(match, "source.index_column");
    return {
      column: match[1],
      prefix: match[2] ?? null,
      direction: match[3]?.toUpperCase() === "DESC" ? "D" : "A",
    };
  });

function columnDefinition(input, table) {
  const match = /^`?([a-z_][a-z0-9_]*)`?\s+([A-Z]+)(?:\s*\((\d+)(?:\s*,\s*(\d+))?\))?/iu.exec(
    input,
  );
  requireCondition(match, "source.column_definition");
  const dataType =
    { BOOLEAN: "tinyint", BOOL: "tinyint", INTEGER: "int", JSON: "longtext", NUMERIC: "decimal" }[
      match[2].toUpperCase()
    ] ?? match[2].toLowerCase();
  requireCondition(
    [
      "bigint",
      "int",
      "smallint",
      "tinyint",
      "longtext",
      "text",
      "varchar",
      "char",
      "uuid",
      "datetime",
      "date",
      "time",
      "varbinary",
      "binary",
      "decimal",
    ].includes(dataType),
    "source.column_type",
  );
  const generatedAt = /GENERATED ALWAYS AS\s*\(/iu.exec(input);
  const checkAt = /\bCHECK\s*\(/iu.exec(input);
  const modifiers = input.slice(
    0,
    Math.min(generatedAt?.index ?? input.length, checkAt?.index ?? input.length),
  );
  const defaultAt = /\bDEFAULT\s+/iu.exec(modifiers);
  let defaultSql = null;
  if (defaultAt) {
    const tail = input.slice(defaultAt.index + defaultAt[0].length),
      token = lexicalParts(tail)[0];
    requireCondition(token, "source.column_default");
    const call = tail.slice(token.end).trimStart().startsWith("(");
    defaultSql = call || token.text === "(" ? tail.slice(0, enclosed(tail).end) : token.text;
  }
  const column = {
    name: match[1],
    type: dataType,
    nullable: !/\bNOT NULL\b|\bPRIMARY KEY\b/iu.test(modifiers),
    size: match[3] ?? null,
    scale: match[4] ?? null,
    unsigned: /\bUNSIGNED\b/iu.test(modifiers),
    charset:
      /CHARACTER SET\s+(\w+)/iu.exec(modifiers)?.[1] ??
      (/char|text/u.test(dataType) ? "utf8mb4" : null),
    collation:
      /COLLATE\s+(\w+)/iu.exec(modifiers)?.[1] ??
      (/char|text/u.test(dataType) ? "utf8mb4_bin" : null),
    auto_increment: /\bAUTO_INCREMENT\b/iu.test(modifiers),
    default_sql: canonicalDefaultSql(defaultSql),
    generated: generatedAt
      ? canonicalMetadataSql(
          enclosed(input, generatedAt.index + generatedAt[0].lastIndexOf("(")).body,
        )
      : null,
    stored: generatedAt ? /\bSTORED\b/iu.test(input) : false,
  };
  if (match[2].toUpperCase() === "JSON")
    table.checks[column.name] = canonicalCheckSql(`json_valid(${column.name})`);
  if (checkAt) {
    requireCondition(match[2].toUpperCase() !== "JSON", "source.inline_json_check");
    table.checks[column.name] = canonicalCheckSql(
      enclosed(input, checkAt.index + checkAt[0].lastIndexOf("(")).body,
    );
  }
  if (/\bPRIMARY KEY\b/iu.test(modifiers))
    addIndex(table, "PRIMARY", [{ column: column.name, prefix: null, direction: "A" }], true);
  if (/\bUNIQUE\b/iu.test(modifiers))
    addIndex(table, column.name, [{ column: column.name, prefix: null, direction: "A" }], true);
  return column;
}
function addIndex(table, name, columns, unique, automatic = false) {
  const covers = (a, b) =>
    b.every((column, index) => a[index]?.column === column.column && a[index]?.prefix === null);
  if (!automatic)
    for (const [oldName, index] of Object.entries(table.indexes))
      if (index.automatic && covers(columns, index.columns)) delete table.indexes[oldName];
  if (automatic && Object.values(table.indexes).some((index) => covers(index.columns, columns)))
    return;
  table.indexes[name] = { name, columns, unique, automatic };
}
function tableClause(table, input) {
  let rest = input,
    constraintName;
  const named = /^CONSTRAINT\s+`?([a-z_][a-z0-9_]*)`?\s+/iu.exec(rest);
  if (named) {
    constraintName = named[1];
    rest = rest.slice(named[0].length);
  }
  if (/^CHECK\s*\(/iu.test(rest)) {
    requireCondition(constraintName, "source.unnamed_check");
    table.checks[constraintName] = canonicalCheckSql(enclosed(rest).body);
    return;
  }
  if (/^FOREIGN KEY\s*\(/iu.test(rest)) {
    requireCondition(constraintName, "source.unnamed_fk");
    const own = enclosed(rest),
      referenced = /\bREFERENCES\s+`?([a-z_][a-z0-9_]*)`?\s*\(/iu.exec(rest.slice(own.end));
    requireCondition(referenced, "source.fk_target");
    const targetText = rest.slice(own.end + referenced.index),
      target = enclosed(targetText);
    const columns = identifiers(own.body);
    table.foreign_keys[constraintName] = {
      name: constraintName,
      columns: columns.map((column) => column.column),
      target_table: referenced[1],
      target_columns: identifiers(target.body).map((column) => column.column),
      delete_rule:
        /ON DELETE\s+(CASCADE|RESTRICT|SET NULL|NO ACTION)/iu.exec(rest)?.[1].toUpperCase() ??
        "RESTRICT",
      update_rule:
        /ON UPDATE\s+(CASCADE|RESTRICT|SET NULL|NO ACTION)/iu.exec(rest)?.[1].toUpperCase() ??
        "RESTRICT",
    };
    addIndex(table, constraintName, columns, false, true);
    return;
  }
  const index =
    /^(PRIMARY KEY|UNIQUE(?: KEY| INDEX)?|INDEX|KEY)(?:\s+`?([a-z_][a-z0-9_]*)`?)?\s*\(/iu.exec(
      rest,
    );
  if (index) {
    const columns = identifiers(enclosed(rest).body),
      primary = index[1].toUpperCase() === "PRIMARY KEY";
    addIndex(
      table,
      primary ? "PRIMARY" : (constraintName ?? index[2] ?? columns[0].column),
      columns,
      primary || /^UNIQUE/iu.test(index[1]),
    );
    return;
  }
  requireCondition(!constraintName, "source.constraint_kind");
  const column = columnDefinition(rest, table);
  table.columns[column.name] = column;
}
function emptyTable(name) {
  return { name, columns: {}, indexes: {}, checks: {}, foreign_keys: {} };
}
function parseGrant(state, input) {
  const grant =
    /^GRANT\s+([\s\S]+?)\s+ON\s+(PROCEDURE\s+)?classhub_mariadb_phase1_dev\.(`?[a-z_][a-z0-9_]*`?|\*)\s+TO\s+'(classhub_[a-z_]+)'@'%'$/iu.exec(
      input,
    );
  requireCondition(grant, "source.grant_shape");
  const object = grant[3].replaceAll("`", ""),
    account = grant[4];
  state.grants[account] ??= [];
  if (grant[1] === "ALL PRIVILEGES") {
    requireCondition(account === "classhub_migrator" && object === "*", "source.grant_all_scope");
    state.migrator_schema_all = true;
    return;
  }
  for (const clause of splitTop(grant[1])) {
    const privilege = /^(SELECT|INSERT|UPDATE|DELETE|TRIGGER|EXECUTE)(?:\s*\(([\s\S]+)\))?$/iu.exec(
      clause,
    );
    requireCondition(privilege && object !== "*", "source.grant_privilege");
    const columns = privilege[2] ? identifiers(privilege[2]).map((entry) => entry.column) : ["*"];
    for (const column of columns)
      state.grants[account].push(
        grant[2]
          ? `procedure|${object}|EXECUTE`
          : `table|${object}|${privilege[1].toUpperCase()}|${column}`,
      );
  }
  state.grants[account] = [...new Set(state.grants[account])].sort();
}
function routineDefinition(state, input) {
  const match =
    /^CREATE(?: OR REPLACE)? DEFINER\s*=\s*['`]classhub_routine['`]@['`]%['`]\s+(PROCEDURE|TRIGGER)\s+([a-z_][a-z0-9_]*)/iu.exec(
      input,
    );
  requireCondition(match, "source.definer_shape");
  const name = match[2],
    tail = input.slice(match[0].length);
  if (match[1].toUpperCase() === "TRIGGER") {
    const trigger =
      /^\s+(BEFORE|AFTER)\s+(INSERT|UPDATE|DELETE)\s+ON\s+([a-z_][a-z0-9_]*)\s+FOR EACH ROW\s+([\s\S]+)$/iu.exec(
        tail,
      );
    requireCondition(trigger, "source.trigger_header");
    state.triggers[name] = {
      name,
      timing: trigger[1].toUpperCase(),
      event: trigger[2].toUpperCase(),
      table: trigger[3],
      body: canonicalMetadataSql(trigger[4]),
      definer: "classhub_routine@%",
    };
    return;
  }
  const parameters = enclosed(tail),
    header = tail.slice(parameters.end);
  const bodyAt = /(?:[a-z_][a-z0-9_]*\s*:\s*)?\bBEGIN\b/iu.exec(header);
  requireCondition(bodyAt, "source.routine_body");
  const params = parameters.body.trim()
    ? splitTop(parameters.body).map((parameter) => {
        const parsed = /^(IN|OUT|INOUT)\s+([a-z_][a-z0-9_]*)\s+([\s\S]+)$/iu.exec(parameter);
        requireCondition(parsed, "source.routine_parameter");
        return {
          mode: parsed[1].toUpperCase(),
          name: parsed[2],
          ...columnDefinition(`${parsed[2]} ${parsed[3]}`, emptyTable("parameter")),
        };
      })
    : [];
  state.routines[name] = {
    name,
    definer: "classhub_routine@%",
    security: /SQL SECURITY\s+(DEFINER|INVOKER)/iu.exec(header)?.[1].toUpperCase(),
    access:
      /(READS SQL DATA|MODIFIES SQL DATA|CONTAINS SQL|NO SQL)/iu.exec(header)?.[1].toUpperCase() ??
      "CONTAINS SQL",
    parameters: params,
    body: canonicalMetadataSql(header.slice(bodyAt.index)),
  };
}

export function emptyInstallState() {
  return {
    tables: {},
    routines: {},
    triggers: {},
    accounts: {},
    grants: {},
    seeds: {},
    migrator_schema_all: false,
  };
}
export function applySourcePostcondition(state, input, artifact) {
  if (artifact === "current-runtime-acl")
    for (const account of ["app", "operator", "worker", "retention"])
      state.grants[`classhub_${account}`] = [];
  for (const statement of sourceStatements(input)) {
    if (statement === "USE classhub_mariadb_phase1_dev") continue;
    if (/^SET\s+(?:time_zone\s*=|NAMES\s)/iu.test(statement)) continue;
    if (
      /^ALTER DATABASE classhub_mariadb_phase1_dev\s+CHARACTER SET utf8mb4\s+COLLATE utf8mb4_bin$/iu.test(
        statement,
      )
    )
      continue;
    const account = /^CREATE USER '(classhub_[a-z_]+)'@'%'[\s\S]*$/iu.exec(statement);
    if (account) {
      state.accounts[account[1]] = {
        name: account[1],
        host: "%",
        locked: /ACCOUNT LOCK\s*$/iu.test(statement),
        require_ssl: /\bREQUIRE SSL\b/iu.test(statement),
      };
      continue;
    }
    if (/^GRANT\s/iu.test(statement)) {
      parseGrant(state, statement);
      continue;
    }
    const table = /^CREATE TABLE\s+([a-z_][a-z0-9_]*)\s*\(/iu.exec(statement);
    if (table) {
      requireCondition(!state.tables[table[1]], "source.duplicate_table");
      const body = enclosed(statement),
        parsed = emptyTable(table[1]);
      requireCondition(
        /ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin/iu.test(
          statement.slice(body.end),
        ),
        "source.table_options",
      );
      for (const clause of splitTop(body.body)) tableClause(parsed, clause);
      state.tables[table[1]] = parsed;
      continue;
    }
    const alter = /^ALTER TABLE\s+([a-z_][a-z0-9_]*)\s+([\s\S]+)$/iu.exec(statement);
    if (alter) {
      const target = state.tables[alter[1]];
      requireCondition(target, "source.alter_target");
      for (const clause of splitTop(alter[2])) {
        const drop = /^DROP (CONSTRAINT|INDEX)\s+([a-z_][a-z0-9_]*)$/iu.exec(clause);
        if (drop) {
          if (drop[1].toUpperCase() === "INDEX") delete target.indexes[drop[2]];
          else {
            delete target.checks[drop[2]];
            delete target.foreign_keys[drop[2]];
          }
          continue;
        }
        const change = /^(ADD(?: COLUMN)?|MODIFY COLUMN)\s+([\s\S]+)$/iu.exec(clause);
        requireCondition(change, "source.alter_clause");
        tableClause(target, change[2]);
      }
      continue;
    }
    const index =
      /^CREATE\s+(UNIQUE\s+)?INDEX\s+([a-z_][a-z0-9_]*)\s+ON\s+([a-z_][a-z0-9_]*)\s*\(/iu.exec(
        statement,
      );
    if (index) {
      requireCondition(state.tables[index[3]], "source.index_target");
      addIndex(
        state.tables[index[3]],
        index[2],
        identifiers(enclosed(statement).body),
        Boolean(index[1]),
      );
      continue;
    }
    if (/^CREATE(?: OR REPLACE)? DEFINER/iu.test(statement)) {
      routineDefinition(state, statement);
      continue;
    }
    const seed =
      /^INSERT INTO (audit_log_actions|retention_lock_keys)\s*\((action|lock_digest)\)\s+VALUES\s+([\s\S]+)$/iu.exec(
        statement,
      );
    if (seed) {
      const values = splitTop(seed[3]).map((row) => {
        const literal = /^\(\s*(?:'([a-z_.]+)'|0x([a-f0-9]{64}))\s*\)$/iu.exec(row);
        requireCondition(literal, "source.seed_literal");
        return literal[1] ?? literal[2].toLowerCase();
      });
      state.seeds[seed[1]] = [...(state.seeds[seed[1]] ?? []), ...values].sort();
      continue;
    }
    if (artifact === "audit-action-catalog" && /^BEGIN NOT ATOMIC\b/iu.test(statement)) continue;
    if (
      artifact === "retained-retention-lock-keys" &&
      /^(START TRANSACTION|COMMIT)$/iu.test(statement)
    )
      continue;
    postconditionFailure(`source.${artifact}.statement_kind`);
  }
  for (const table of Object.values(state.tables)) {
    for (const column of table.indexes.PRIMARY?.columns ?? [])
      table.columns[column.column].nullable = false;
    for (const index of Object.values(table.indexes))
      index.type =
        index.unique &&
        index.columns.some(
          (part) => /text/u.test(table.columns[part.column]?.type) && part.prefix === null,
        )
          ? "HASH"
          : "BTREE";
  }
  return state;
}
