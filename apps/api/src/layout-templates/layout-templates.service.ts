import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { LayoutDraftsAccessService } from "../layout-drafts/layout-drafts.access.service.js";
import {
  LayoutTemplateInvalidException,
  LayoutTemplateLimitReachedException,
  LayoutTemplateNotFoundException,
} from "./layout-templates.errors.js";
import type { LayoutTemplateItem, LayoutTemplateListResult } from "./layout-templates.types.js";

/*
 * 담는 것이 행·열·못 쓰는 자리 목록뿐이라 서른 자리 교실에서 몇 백 바이트다. 임시저장
 * (256KB)보다 훨씬 작게 잡아도 넉넉하다 — 모양을 검사하지 않기로 했으므로 크기라도
 * 봐야 잘못된 클라이언트가 DB를 채우는 것을 막는다.
 */
const PAYLOAD_MAX_BYTES = 32 * 1024;

/*
 * 한 교사가 저장할 수 있는 개수. 교실 배치는 "우리 교실 기본형 · 시험 대형 · 모둠형"
 * 정도라 스물이면 넉넉하다. 상한이 없으면 목록 화면이 감당 못 하는 수까지 쌓인다.
 */
const TEMPLATE_LIMIT = 20;

const NAME_MAX_LENGTH = 40;

interface TemplateRow {
  created_at: Date;
  id: string;
  name: string;
  payload: unknown;
  updated_at: Date;
}

@Injectable()
export class LayoutTemplatesService {
  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    /*
     * 역할 판정은 임시저장 것을 그대로 쓴다. 조건이 한 글자도 다르지 않은데 사본을
     * 만들면 T-HUB-20 부채가 열한 벌이 되고, 나중에 한쪽만 고쳐져 구멍이 된다.
     */
    private readonly accessService: LayoutDraftsAccessService,
  ) {}

  async list(input: { actorUserId: string }): Promise<LayoutTemplateListResult> {
    const actor = await this.accessService.teacherActor(input.actorUserId);
    const rows = (await this.database
      .selectFrom("classroom_layout_templates")
      .select(["created_at", "id", "name", "payload", "updated_at"])
      .where("class_id", "=", actor.classId)
      .where("member_id", "=", actor.memberId)
      .orderBy("updated_at", "desc")
      .orderBy("id", "desc")
      .limit(TEMPLATE_LIMIT)
      .execute()) as TemplateRow[];
    return { items: rows.map((row) => this.toItem(row)) };
  }

  /*
   * 저장은 **이름 기준 덮어쓰기**다. 같은 이름을 두 번 저장하면 덮는다 — 목록에 같은
   * 이름이 둘 있으면 사람이 어느 것을 부를지 알 수 없다. DB의 UNIQUE 가 이걸 못박고
   * 있어 경합이 나도 행이 둘로 갈라지지 않는다.
   */
  async save(input: {
    actorUserId: string;
    name: string;
    payload: unknown;
  }): Promise<LayoutTemplateItem> {
    const actor = await this.accessService.teacherActor(input.actorUserId);
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (name.length === 0 || name.length > NAME_MAX_LENGTH) {
      throw new LayoutTemplateInvalidException(`배치 이름은 1~${NAME_MAX_LENGTH}자로 적어 주세요.`);
    }
    /* DB의 name CHECK 와 같은 조건을 앞당겨 막는다 — 제어문자는 이름에 쓸 수 없다. */
    if (/\p{Cc}/u.test(name)) {
      throw new LayoutTemplateInvalidException("배치 이름에 쓸 수 없는 문자가 있습니다.");
    }
    const serialized = JSON.stringify(input.payload);
    if (serialized === undefined) {
      throw new LayoutTemplateInvalidException("저장할 내용을 읽을 수 없습니다.");
    }
    if (Buffer.byteLength(serialized, "utf8") > PAYLOAD_MAX_BYTES) {
      throw new LayoutTemplateInvalidException("저장할 내용이 너무 큽니다.");
    }

    return this.database.transaction().execute(async (transaction) => {
      /*
       * **같은 사람의 저장을 한 줄로 세운다.**
       *
       * 아래 `FOR UPDATE` 는 **행이 있을 때만** 잠근다. 새 이름 둘을 동시에 저장하면
       * 서로 잠글 행이 없어 둘 다 `count = 19` 를 읽고 둘 다 들어간다 — DB 에는 21개가
       * 되고 목록은 `LIMIT 20` 이라 **하나가 조용히 숨는다.** 숨은 것은 화면에서 찾아
       * 지울 수도 없다(2026-08-22 감사 BLUE-04).
       *
       * 없는 행은 잠글 수 없으므로 **주인(member) 을 잠근다.** advisory lock 은 트랜잭션이
       * 끝나면 저절로 풀리고, 표에 새 열이나 트리거를 더하지 않아도 된다.
       * 키에 표 이름을 섞어 다른 기능의 잠금과 부딪히지 않게 한다.
       */
      await sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended('classroom_layout_templates:' || ${actor.memberId}::text, 0)
        )
      `.execute(transaction);

      /*
       * 상한은 **새 이름일 때만** 본다. 이미 있는 이름을 덮어쓰는 것은 개수를 늘리지
       * 않으므로, 스물이 찼다고 기존 배치 수정까지 막으면 사람이 갇힌다.
       */
      const existing = await transaction
        .selectFrom("classroom_layout_templates")
        .select("id")
        .where("class_id", "=", actor.classId)
        .where("member_id", "=", actor.memberId)
        .where("name", "=", name)
        .forUpdate()
        .executeTakeFirst();
      if (existing === undefined) {
        const counted = await transaction
          .selectFrom("classroom_layout_templates")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("class_id", "=", actor.classId)
          .where("member_id", "=", actor.memberId)
          .executeTakeFirstOrThrow();
        if (Number(counted.count) >= TEMPLATE_LIMIT) {
          throw new LayoutTemplateLimitReachedException(TEMPLATE_LIMIT);
        }
      }

      const saved = (await transaction
        .insertInto("classroom_layout_templates")
        .values({
          class_id: actor.classId,
          member_id: actor.memberId,
          name,
          payload: sql`${serialized}::jsonb`,
        })
        .onConflict((conflict) =>
          conflict.columns(["class_id", "member_id", "name"]).doUpdateSet({
            payload: sql`${serialized}::jsonb`,
            row_version: sql`classroom_layout_templates.row_version + 1`,
            updated_at: sql`clock_timestamp()`,
          }),
        )
        .returning(["created_at", "id", "name", "payload", "updated_at"])
        .executeTakeFirstOrThrow()) as TemplateRow;
      return this.toItem(saved);
    });
  }

  async delete(input: { actorUserId: string; templateId: string }): Promise<void> {
    const actor = await this.accessService.teacherActor(input.actorUserId);
    if (!/^[1-9][0-9]*$/u.test(input.templateId)) throw new LayoutTemplateNotFoundException();
    const deleted = await this.database
      .deleteFrom("classroom_layout_templates")
      .where("id", "=", input.templateId)
      .where("class_id", "=", actor.classId)
      .where("member_id", "=", actor.memberId)
      .returning("id")
      .executeTakeFirst();
    if (deleted === undefined) throw new LayoutTemplateNotFoundException();
  }

  private toItem(row: TemplateRow): LayoutTemplateItem {
    return {
      created_at: row.created_at.toISOString(),
      id: row.id,
      name: row.name,
      payload: row.payload,
      updated_at: row.updated_at.toISOString(),
    };
  }
}
