import { describe, expect, it } from "vitest";

import type { ClassHubDatabase } from "../database/database.module.js";
import { MemberBirthDateReader } from "./member-birth-dates.js";
import type { MemberListItem } from "./members.types.js";

function fakeDatabase(rows: Array<{ id: string; birth_date: Date | null }>) {
  const asked: unknown[] = [];
  const chain = {
    innerJoin: () => chain,
    select: () => chain,
    where: (_column: string, _operator: string, ids: unknown) => {
      asked.push(ids);
      return chain;
    },
    execute: async () => rows,
  };
  return { asked, database: { selectFrom: () => chain } as unknown as ClassHubDatabase };
}
const installed = { get: () => true } as never;
const member = (id: string, status: MemberListItem["status"]) =>
  ({ id, status }) as unknown as MemberListItem;

describe("MemberBirthDateReader", () => {
  it("adds birth dates only to pending members and never asks for others (I2-03, I5-07)", async () => {
    const { asked, database } = fakeDatabase([
      { id: "1", birth_date: new Date("2010-03-05T00:00:00Z") },
    ]);
    const reader = new MemberBirthDateReader(database, installed);
    const result = await reader.attach([
      member("1", "pending"),
      member("2", "approved"),
      member("3", "removed"),
    ]);
    expect(asked).toEqual([["1"]]);
    expect(result.map((item) => [item.id, item.birth_date])).toEqual([
      ["1", "2010-03-05"],
      ["2", null],
      ["3", null],
    ]);
  });

  it("does not query at all when nobody is pending", async () => {
    const { asked, database } = fakeDatabase([]);
    const reader = new MemberBirthDateReader(database, installed);
    const result = await reader.attach([member("2", "approved")]);
    expect(asked).toEqual([]);
    expect(result[0]?.birth_date).toBeNull();
  });
});
