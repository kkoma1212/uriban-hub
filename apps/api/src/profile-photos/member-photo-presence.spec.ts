import type { DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
} from "kysely";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedFastifyRequest } from "../auth/authenticated-request.js";
import type { ClassChatService } from "../class-chat/class-chat.service.js";
import { ClassChatController } from "../class-chat/class-chat.controller.js";
import type { ClassChatState } from "../class-chat/class-chat.types.js";
import type { AppEnvironment } from "../config/environment.js";
import { HelpRequestsController } from "../help-requests/help-requests.controller.js";
import type { HelpRequestsService } from "../help-requests/help-requests.service.js";
import type { HelpRequestThread } from "../help-requests/help-requests.types.js";
import type { MemberBirthDateReader } from "../members/member-birth-dates.js";
import { MembersController } from "../members/members.controller.js";
import type { MembersService } from "../members/members.service.js";
import type { MemberListItem } from "../members/members.types.js";
import { NoticesController } from "../notices/notices.controller.js";
import type { NoticesService } from "../notices/notices.service.js";
import { MemberPhotoPresenceReader } from "./member-photo-presence.js";
import type { ProfilePhotoActor } from "./profile-photo.types.js";

const actor: ProfilePhotoActor = { userId: "31", sessionId: "session-31", currentClassId: "7" };

function capturingDatabase(engine: "postgres" | "mariadb", rows: Record<string, unknown>[]) {
  const queries: CompiledQuery[] = [];
  const connection = {
    executeQuery: async (query: CompiledQuery) => {
      queries.push(query);
      return { rows };
    },
    streamQuery: async function* () {
      throw new Error("Unexpected stream");
      yield { rows: [] };
    },
  } as DatabaseConnection;
  class Driver extends DummyDriver {
    override async acquireConnection() {
      return connection;
    }
  }
  const database = new Kysely<DB>({
    dialect: {
      createAdapter: () => (engine === "mariadb" ? new MysqlAdapter() : new PostgresAdapter()),
      createDriver: () => new Driver(),
      createIntrospector: (db) =>
        engine === "mariadb" ? new MysqlIntrospector(db) : new PostgresIntrospector(db),
      createQueryCompiler: () =>
        engine === "mariadb" ? new MysqlQueryCompiler() : new PostgresQueryCompiler(),
    },
  });
  return { database, queries };
}

const config = (enabled: boolean) =>
  new ConfigService<AppEnvironment, true>({ PROFILE_PHOTOS_ENABLED: enabled });

describe.each(["postgres", "mariadb"] as const)("MemberPhotoPresenceReader (%s)", (engine) => {
  it("고르는 조건은 사진 조회와 같고, 사진 바이트는 읽지 않으며, 같은 번호는 한 번만 묻는다", async () => {
    const { database, queries } = capturingDatabase(engine, [{ member_id: "56" }]);
    const reader = new MemberPhotoPresenceReader(database, config(true));

    const found = await reader.memberIdsWithPhoto(actor, ["56", "57", "56"]);

    expect([...found]).toEqual(["56"]);
    expect(queries).toHaveLength(1);
    const plain = queries[0]!.sql.replaceAll('"', "").replaceAll(String.fromCharCode(96), "");
    expect(plain).not.toContain("image_bytes");
    expect(plain).toContain("viewer.class_id = target.class_id");
    expect(plain).toMatch(/target\.id in \((\$\d+|\?), (\$\d+|\?)\)/u);
    // 앞부분은 사진 조회(classProfilePhotoQuery)와 같은 경계 값, 끝은 고를 구성원 번호.
    expect(queries[0]!.parameters).toEqual([
      "31",
      "7",
      "approved",
      "approved",
      "active",
      true,
      true,
      "student",
      "teacher",
      "active",
      false,
      "student",
      "teacher",
      "active",
      false,
      "56",
      "57",
    ]);
    await database.destroy();
  });

  it("사진 기능이 꺼졌거나, 현재 반이 없거나, 고를 번호가 없으면 DB를 묻지 않고 모두 없음이다", async () => {
    const { database, queries } = capturingDatabase(engine, [{ member_id: "56" }]);
    expect(
      (
        await new MemberPhotoPresenceReader(database, config(false)).memberIdsWithPhoto(actor, [
          "56",
        ])
      ).size,
    ).toBe(0);
    expect(
      (await new MemberPhotoPresenceReader(database).memberIdsWithPhoto(actor, ["56"])).size,
    ).toBe(0);
    const reader = new MemberPhotoPresenceReader(database, config(true));
    expect((await reader.memberIdsWithPhoto({ ...actor, currentClassId: null }, ["56"])).size).toBe(
      0,
    );
    expect((await reader.memberIdsWithPhoto(actor, [])).size).toBe(0);
    expect(
      await new MemberPhotoPresenceReader(database, config(false)).classTeacherHasPhoto(actor),
    ).toBe(false);
    expect(await reader.classTeacherHasPhoto({ ...actor, currentClassId: null })).toBe(false);
    expect(queries).toHaveLength(0);
    await database.destroy();
  });

  it("담임 사진 여부는 담임 사진 경로와 같은 경계로 담임 한 명만 묻는다", async () => {
    const { database, queries } = capturingDatabase(engine, [{ member_id: "1" }]);
    const reader = new MemberPhotoPresenceReader(database, config(true));
    expect(await reader.classTeacherHasPhoto(actor)).toBe(true);
    expect(queries).toHaveLength(1);
    expect(
      queries[0]!.sql.replaceAll('"', "").replaceAll(String.fromCharCode(96), ""),
    ).not.toContain("image_bytes");
    expect(queries[0]!.parameters.slice(0, 2)).toEqual(["31", "7"]);
    expect(queries[0]!.parameters.at(-1)).toBe("teacher");
    const none = capturingDatabase(engine, []);
    expect(
      await new MemberPhotoPresenceReader(none.database, config(true)).classTeacherHasPhoto(actor),
    ).toBe(false);
    await database.destroy();
    await none.database.destroy();
  });
});

describe("사진을 그리는 응답은 구성원마다 has_profile_photo를 가진다", () => {
  const request = { authenticatedSession: actor } as unknown as AuthenticatedFastifyRequest;
  const photos = () => {
    const memberIdsWithPhoto = vi.fn(
      async (_actor: ProfilePhotoActor, ids: readonly string[]) =>
        new Set(ids.filter((id) => id === "2")),
    );
    const classTeacherHasPhoto = vi.fn(async () => true);
    return {
      reader: { classTeacherHasPhoto, memberIdsWithPhoto } as unknown as MemberPhotoPresenceReader,
      classTeacherHasPhoto,
      memberIdsWithPhoto,
    };
  };

  it("학생 관리 목록", async () => {
    const { reader, memberIdsWithPhoto } = photos();
    const members = [{ id: "2" }, { id: "3" }] as MemberListItem[];
    const controller = new MembersController(
      { list: async () => ({ members }) } as unknown as MembersService,
      { attach: async (items: MemberListItem[]) => items } as unknown as MemberBirthDateReader,
      reader,
    );
    const result = await controller.list({}, request);
    expect(result.members.map((member) => [member.id, member.has_profile_photo])).toEqual([
      ["2", true],
      ["3", false],
    ]);
    expect(memberIdsWithPhoto).toHaveBeenCalledWith(actor, ["2", "3"]);
  });

  it("공지 확인 현황(다른 값은 그대로)", async () => {
    const { reader } = photos();
    const listed = {
      content_revision: "4",
      counts: { confirmed: 1 },
      items: [{ member_id: "2" }, { member_id: "3" }],
      next_cursor: null,
    };
    const controller = new NoticesController(
      { listConfirmations: async () => listed } as unknown as NoticesService,
      reader,
    );
    const result = await controller.listConfirmations("9", { state: "unread" } as never, request);
    expect(result).toMatchObject({
      content_revision: "4",
      counts: { confirmed: 1 },
      next_cursor: null,
    });
    expect(result.items.map((item) => item.has_profile_photo)).toEqual([true, false]);
  });

  it("반 대화: 상태를 돌려주는 조회·보내기·가리기·방 열고 닫기 모두", async () => {
    const { reader } = photos();
    const chat = {
      messages: [{ author: { member_id: "2" } }, { author: { member_id: "3" } }],
      room: { is_open: true },
    } as unknown as ClassChatState;
    const service = {
      hide: async () => chat,
      send: async () => chat,
      setRoom: async () => chat,
      state: async () => chat,
    } as unknown as ClassChatService;
    const controller = new ClassChatController(service, reader);
    for (const pending of [
      controller.state({}, request),
      controller.send({ body: "안녕" }, request),
      controller.hide("5", request),
      controller.setRoom({ is_open: false }, request),
    ]) {
      const result = await pending;
      expect(result.room).toEqual({ is_open: true });
      expect(result.messages.map((message) => message.author.has_profile_photo)).toEqual([
        true,
        false,
      ]);
    }
  });

  it("도움 요청 대화: 담임이 받는 대화는 학생 사진, 학생이 받는 대화(student 없음)는 담임 사진 여부", async () => {
    const { reader, classTeacherHasPhoto, memberIdsWithPhoto } = photos();
    const forTeacher = {
      messages: [],
      request: { id: "8", student: { display_name: "학생", member_id: "2", student_number: 1 } },
    } as unknown as HelpRequestThread;
    const forStudent = {
      messages: [],
      request: { id: "8", student: null },
    } as unknown as HelpRequestThread;
    const controller = new HelpRequestsController(
      {
        send: async () => forTeacher,
        startGeneral: async () => forStudent,
        thread: async () => forTeacher,
      } as unknown as HelpRequestsService,
      reader,
    );
    expect((await controller.thread("8", request)).request.student?.has_profile_photo).toBe(true);
    expect(
      (await controller.send("8", { body: "네" }, request)).request.student?.has_profile_photo,
    ).toBe(true);
    expect(classTeacherHasPhoto).not.toHaveBeenCalled();
    memberIdsWithPhoto.mockClear();
    const started = await controller.startGeneral({ body: "질문" }, request);
    expect(started.request.student).toBeNull();
    expect(started.teacher_has_profile_photo).toBe(true);
    expect(classTeacherHasPhoto).toHaveBeenCalledWith(actor);
    expect(memberIdsWithPhoto).not.toHaveBeenCalled();
  });
});
