import { Inject, Injectable } from "@nestjs/common";

import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { LayoutDraftsAccessService } from "./layout-drafts.access.service.js";
import {
  LayoutDraftInvalidException,
  LayoutDraftNotFoundException,
} from "./layout-drafts.errors.js";
import type { LayoutDraftItem, LayoutDraftKind } from "./layout-drafts.types.js";

/*
 * 임시저장 본문의 상한. 자리 배치 마법사가 담는 것은 좌석 좌표·제외 명단·고정 배치라
 * 서른 명 학급에서 몇 KB면 넉넉하다. 상한을 두는 이유는 payload 모양을 검사하지 않기로
 * 했기 때문이다 — 모양을 안 보면 크기라도 봐야 잘못된 클라이언트가 DB를 채우는 것을 막는다.
 */
const PAYLOAD_MAX_BYTES = 256 * 1024;

interface DraftRow {
  kind: string;
  payload: unknown;
  row_version: string;
  updated_at: Date;
}

@Injectable()
export class LayoutDraftsService {
  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    private readonly accessService: LayoutDraftsAccessService,
  ) {}

  async get(input: { actorUserId: string; kind: LayoutDraftKind }): Promise<LayoutDraftItem> {
    const actor = await this.accessService.teacherActor(input.actorUserId);
    const row = (await this.database
      .selectFrom("layout_draft_autosaves")
      .select(["kind", "payload", "row_version", "updated_at"])
      .where("class_id", "=", actor.classId)
      .where("member_id", "=", actor.memberId)
      .where("kind", "=", input.kind)
      .executeTakeFirst()) as DraftRow | undefined;
    if (row === undefined) throw new LayoutDraftNotFoundException();
    return this.toItem(row);
  }

  /*
   * 저장은 덮어쓰기 하나다. 마법사가 값이 바뀔 때마다 부르므로 "만들기"와 "고치기"를
   * 가르면 클라이언트가 그 상태를 따라다녀야 한다 — 그건 화면이 할 일이 아니다.
   * 한 사람이 한 종류에 하나만 갖는 것은 DB의 UNIQUE가 못박고 있어, 경합이 나도
   * 행이 둘로 갈라지지 않는다.
   */
  async save(input: {
    actorUserId: string;
    kind: LayoutDraftKind;
    payload: unknown;
  }): Promise<LayoutDraftItem> {
    const actor = await this.accessService.teacherActor(input.actorUserId);
    const serialized = JSON.stringify(input.payload);
    if (serialized === undefined) {
      throw new LayoutDraftInvalidException("임시저장할 내용을 읽을 수 없습니다.");
    }
    if (Buffer.byteLength(serialized, "utf8") > PAYLOAD_MAX_BYTES) {
      throw new LayoutDraftInvalidException("임시저장할 내용이 너무 큽니다.");
    }

    const row = (await this.database
      .insertInto("layout_draft_autosaves")
      .values({
        class_id: actor.classId,
        kind: input.kind,
        member_id: actor.memberId,
        payload: serialized,
      })
      .onConflict((conflict) =>
        conflict.columns(["class_id", "member_id", "kind"]).doUpdateSet((builder) => ({
          payload: serialized,
          row_version: builder.ref("layout_draft_autosaves.row_version"),
          updated_at: new Date(),
        })),
      )
      .returning(["kind", "payload", "row_version", "updated_at"])
      .executeTakeFirstOrThrow()) as DraftRow;
    return this.toItem(row);
  }

  /*
   * 학생에게 공개하고 나면 만들던 내용은 쓸모가 없다(Hex 결정). 화면이 공개 직후
   * 이걸 부른다. 없는 것을 지우는 것도 성공으로 둔다 — 임시저장 없이 바로 만든
   * 경우가 정상이고, 거기서 오류를 내면 공개가 실패한 것처럼 보인다.
   */
  async clear(input: { actorUserId: string; kind: LayoutDraftKind }): Promise<void> {
    const actor = await this.accessService.teacherActor(input.actorUserId);
    await this.database
      .deleteFrom("layout_draft_autosaves")
      .where("class_id", "=", actor.classId)
      .where("member_id", "=", actor.memberId)
      .where("kind", "=", input.kind)
      .execute();
  }

  private toItem(row: DraftRow): LayoutDraftItem {
    return {
      kind: row.kind as LayoutDraftKind,
      payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
      row_version: String(row.row_version),
      updated_at: row.updated_at.toISOString(),
    };
  }
}
