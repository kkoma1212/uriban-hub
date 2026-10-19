import assert from "node:assert/strict";

/** Lex the pinned MariaDB sources for object dependencies, never execute/translate SQL.
 * The reviewed creation SQL uses doubled quotes and normal MariaDB backslash escaping.
 * Literal/comment text cannot invent dependencies. Versioned comments and dynamic SQL
 * require a separate review and are refused rather than treated as ordinary comments.
 */
function tokens(source) {
  const result = [];
  let offset = 0,
    line = 1;
  while (offset < source.length) {
    const current = source[offset],
      next = source[offset + 1];
    if (/\s/u.test(current)) {
      if (current === "\n") line++;
      offset++;
      continue;
    }
    if (
      current === "#" ||
      (current === "-" && next === "-" && /\s/u.test(source[offset + 2] ?? "\n"))
    ) {
      while (offset < source.length && source[offset] !== "\n") offset++;
      continue;
    }
    if (current === "/" && next === "*") {
      assert.doesNotMatch(
        source.slice(offset + 2, offset + 4),
        /^(?:!|M!|\+)/iu,
        "Executable semantic comment requires review",
      );
      const end = source.indexOf("*/", offset + 2);
      assert.ok(end !== -1, "Unterminated semantic SQL comment");
      const comment = source.slice(offset + 2, end);
      assert.ok(!comment.includes("/*"), "Nested semantic SQL comment requires review");
      line += (comment.match(/\n/gu) ?? []).length;
      offset = end + 2;
      continue;
    }
    if (["'", '"', "`"].includes(current)) {
      const quote = current,
        startLine = line;
      let value = "",
        closed = false;
      for (offset++; offset < source.length; offset++) {
        const char = source[offset];
        if (char === "\n") line++;
        if (char === "\\" && quote !== "`") {
          assert.ok(offset + 1 < source.length, "Unterminated semantic SQL escape");
          value += source[++offset];
          continue;
        }
        if (char !== quote) {
          value += char;
          continue;
        }
        if (source[offset + 1] === quote) {
          value += quote;
          offset++;
          continue;
        }
        offset++;
        closed = true;
        break;
      }
      assert.ok(closed, "Unterminated semantic SQL quote");
      result.push({ kind: quote === "`" ? "identifier" : "literal", value, line: startLine });
      continue;
    }
    const word = /^[a-z_][a-z0-9_]*/iu.exec(source.slice(offset))?.[0];
    if (word !== undefined) {
      result.push({ kind: "word", value: word, line });
      offset += word.length;
      continue;
    }
    result.push({ kind: "symbol", value: current, line });
    offset++;
  }
  return result;
}

export function inspectMariaDbSemanticSql(source) {
  assert.equal(typeof source, "string");
  const all = tokens(source),
    definitions = [],
    references = [],
    mutations = [];
  const word = (index, expected) =>
    all[index]?.kind === "word" && all[index].value.toUpperCase() === expected;
  const identifier = (index) =>
    ["word", "identifier"].includes(all[index]?.kind) ? all[index].value : null;
  const add = (list, kind, object, line) => {
    assert.equal(typeof object, "string", `Missing ${kind} object at line ${line}`);
    assert.match(object, /^[a-z_][a-z0-9_]*$/u, `Unreviewed ${kind} identifier`);
    if (!list.some((entry) => entry.kind === kind && entry.object === object))
      list.push({ kind, object, line });
  };
  function principal(index, list, kind) {
    const account = all[index],
      separator = all[index + 1],
      host = all[index + 2];
    assert.ok(
      ["literal", "identifier"].includes(account?.kind) &&
        separator?.value === "@" &&
        ["literal", "identifier"].includes(host?.kind),
      "Unreviewed semantic principal syntax",
    );
    assert.equal(host.value, "%", "Unreviewed semantic principal host");
    add(list, kind, account.value, account.line);
    return index + 3;
  }
  function table(index, kind, line) {
    const name = identifier(index);
    if (name === null) return;
    if (all[index + 1]?.value === ".") {
      assert.equal(name, "classhub_mariadb_phase1_dev", "Unreviewed database-qualified reference");
      if (all[index + 2]?.value === "*") return;
      add(references, kind, identifier(index + 2), line);
    } else if (name.toUpperCase() !== "DUAL") add(references, kind, name, line);
  }
  for (let index = 0; index < all.length; index++) {
    const token = all[index];
    if (token.kind !== "word") continue;
    const keyword = token.value.toUpperCase();
    assert.notEqual(keyword, "PREPARE", "Dynamic SQL requires a separate semantic review");
    if (keyword === "EXECUTE" && !word(index - 1, "GRANT"))
      throw new Error("Dynamic SQL or unreviewed EXECUTE syntax");
    assert.notEqual(keyword, "RENAME", "RENAME requires a separate semantic review");
    if (keyword === "REPLACE" && !word(index - 1, "OR"))
      throw new Error("REPLACE requires a separate semantic review");
    if (
      keyword === "DROP" &&
      ["TABLE", "PROCEDURE", "TRIGGER", "DATABASE"].some((kind) => word(index + 1, kind))
    )
      throw new Error("Object deletion requires a separate semantic review");
    if (keyword === "CREATE") {
      let cursor = index + 1;
      const replacing = word(cursor, "OR") && word(cursor + 1, "REPLACE");
      if (replacing) cursor += 2;
      if (word(cursor, "DEFINER")) {
        assert.equal(all[cursor + 1]?.value, "=");
        cursor = principal(cursor + 2, references, "definer");
      }
      if (word(cursor, "USER")) {
        principal(cursor + 1, definitions, "principal");
        continue;
      }
      if (word(cursor, "TABLE") || word(cursor, "PROCEDURE") || word(cursor, "TRIGGER")) {
        const kind = all[cursor].value.toLowerCase(),
          name = identifier(cursor + 1);
        add(definitions, kind, name, token.line);
        if (replacing) add(references, `replace_${kind}`, name, token.line);
        if (kind === "trigger") {
          assert.ok(["BEFORE", "AFTER"].some((value) => word(cursor + 2, value)));
          assert.ok(["INSERT", "UPDATE", "DELETE"].some((value) => word(cursor + 3, value)));
          assert.ok(word(cursor + 4, "ON"));
          table(cursor + 5, "trigger_target", token.line);
        }
      } else {
        if (word(cursor, "UNIQUE")) cursor++;
        assert.ok(word(cursor, "INDEX"), `Unreviewed CREATE statement at line ${token.line}`);
        assert.ok(word(cursor + 2, "ON"));
        table(cursor + 3, "index_target", token.line);
      }
    } else if (keyword === "ALTER" && word(index + 1, "TABLE")) {
      table(index + 2, "alter_table", token.line);
      add(mutations, "alter_table", identifier(index + 2), token.line);
    } else if (keyword === "REFERENCES") table(index + 1, "foreign_key", token.line);
    else if (keyword === "CALL") add(references, "call", identifier(index + 1), token.line);
    else if (keyword === "FROM" || keyword === "JOIN") table(index + 1, "table_read", token.line);
    else if (keyword === "INSERT" && word(index + 1, "INTO"))
      table(index + 2, "table_insert", token.line);
    else if (
      keyword === "UPDATE" &&
      !word(index - 1, "FOR") &&
      !word(index - 1, "ON") &&
      all[index + 1]?.kind === "word" &&
      word(index + 2, "SET")
    )
      table(index + 1, "table_update", token.line);
    else if (keyword === "GRANT") {
      let cursor = index + 1;
      while (cursor < all.length && !word(cursor, "ON") && all[cursor].value !== ";") cursor++;
      assert.ok(word(cursor, "ON"), "Unreviewed semantic GRANT target");
      cursor++;
      const routine = word(cursor, "PROCEDURE");
      if (routine) cursor++;
      if (routine) {
        assert.equal(identifier(cursor), "classhub_mariadb_phase1_dev");
        assert.equal(all[cursor + 1]?.value, ".");
        add(references, "grant_execute", identifier(cursor + 2), token.line);
      } else table(cursor, "grant_table", token.line);
      while (cursor < all.length && !word(cursor, "TO") && all[cursor].value !== ";") cursor++;
      assert.ok(word(cursor, "TO"), "Unreviewed semantic GRANT grantee");
      const end = principal(cursor + 1, references, "grantee");
      assert.equal(
        all[end]?.value,
        ";",
        "Multiple grantees or extra grant authority require review",
      );
    }
  }
  return { definitions, references, mutations };
}
