import {
  createIdempotencyRequestHash,
  createIdempotencyRouteKey,
  IdempotencyService,
  MariaDbIdempotencyService,
  type DB,
  type JsonObject,
} from "@classhub/db";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql, type RawBuilder, type Transaction } from "kysely";

import { parseRequiredIfMatch, ResourceVersionChangedException } from "../common/http/if-match.js";
import { mariaDbDateBinding } from "../common/database/mariadb-values.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { ElectionsAccessService, type ElectionActorContext } from "./elections.access.service.js";
import {
  ELECTION_RETURNING,
  electionDatabase,
  insertElection,
  insertElectionCandidate,
  updateElection,
  type ElectionDatabaseEngine,
} from "./mariadb/elections-database.js";
import {
  ElectionAlreadyVotedException,
  ElectionCandidateAlreadyRegisteredException,
  ElectionInvalidException,
  ElectionNotFoundException,
  ElectionNotOpenException,
  ElectionRevoteRequiredException,
  ElectionRoleInsufficientException,
  ElectionStatusConflictException,
  ElectionTieBreakRequiredException,
  mapElectionIdempotencyError,
} from "./elections.errors.js";
import {
  assertPositiveElectionId,
  electionSummary,
  MAX_ELECTION_CANDIDATES,
  type ElectionCandidateRow,
  type ElectionRow,
} from "./elections.model.js";
import type {
  CastElectionVoteCommand,
  CloseElectionCommand,
  CreateElectionCommand,
  ElectionCurrentResult,
  ElectionItem,
  ElectionListResult,
  ElectionResults,
  GetCurrentElectionQuery,
  GetElectionQuery,
  GetElectionResultsQuery,
  ListElectionsQuery,
  OpenElectionCommand,
  PublishElectionCommand,
  RegisterElectionCandidateCommand,
} from "./elections.types.js";

const CREATE_ROUTE = "/elections";
const HISTORY_LIMIT = 50;

type ElectionItemJson = ElectionItem & JsonObject;

@Injectable()
export class ElectionsService {
  private readonly idempotency: IdempotencyService | MariaDbIdempotencyService;
  private readonly database: ClassHubDatabase;
  private readonly engine: ElectionDatabaseEngine;

  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    private readonly access: ElectionsAccessService,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
  ) {
    ({ database: this.database, engine: this.engine } = electionDatabase(database, config));
    this.idempotency =
      this.engine === "mariadb"
        ? new MariaDbIdempotencyService(this.database)
        : new IdempotencyService(this.database);
  }

  async list(query: ListElectionsQuery): Promise<ElectionListResult> {
    const actor = await this.access.actor(query.actorUserId);
    this.access.assertTeacher(actor, "이 반의 선생님만 선거 목록을 볼 수 있어요.");
    const rows = (await this.database
      .selectFrom("elections")
      .select(ELECTION_RETURNING)
      .where("class_id", "=", actor.classId)
      .orderBy("id", "desc")
      .limit(HISTORY_LIMIT)
      .execute()) as ElectionRow[];
    return { items: rows.map((row) => electionSummary(row)) };
  }

  async get(query: GetElectionQuery): Promise<ElectionItem> {
    const actor = await this.access.actor(query.actorUserId);
    this.access.assertTeacher(actor, "이 반의 선생님만 선거 상세를 볼 수 있어요.");
    assertPositiveElectionId(query.electionId);
    const row = (await this.database
      .selectFrom("elections")
      .select(ELECTION_RETURNING)
      .where("class_id", "=", actor.classId)
      .where("id", "=", query.electionId)
      .executeTakeFirst()) as ElectionRow | undefined;
    if (row === undefined) throw new ElectionNotFoundException();
    return this.itemForRow(this.database, row);
  }

  async create(command: CreateElectionCommand): Promise<ElectionItem> {
    const preliminary = await this.access.actor(command.actorUserId);
    this.access.assertTeacher(preliminary, "이 반의 선생님만 선거를 만들 수 있어요.");

    try {
      const result = await this.idempotency.execute<ElectionItemJson>(
        {
          actorUserId: command.actorUserId,
          idempotencyKey: command.idempotencyKey as string,
          requestHash: createIdempotencyRequestHash({
            body: {
              results_visibility: command.resultsVisibility,
              tie_break: command.tieBreak,
              title: command.title,
            },
            effectiveClassId: preliminary.classId,
          }),
          routeKey: createIdempotencyRouteKey(CREATE_ROUTE, preliminary.classId),
        },
        async (transaction) => {
          const actor = await this.access.lockActor(transaction, preliminary, command.actorUserId);
          this.access.assertTeacher(actor, "이 반의 선생님만 선거를 만들 수 있어요.");

          const created = await insertElection(
            transaction,
            {
              class_id: actor.classId,
              created_by_member_id: actor.memberId,
              results_visibility: command.resultsVisibility,
              tie_break: command.tieBreak,
              title: command.title,
            },
            this.engine,
          );

          await this.writeAudit(transaction, {
            action: "election.created",
            actor,
            actorUserId: command.actorUserId,
            requestId: command.requestId,
            targetId: created.id,
          });

          const body = await this.itemForRow(transaction, created);
          return { body: body as ElectionItemJson, statusCode: 201 };
        },
      );
      return result.body as unknown as ElectionItem;
    } catch (error) {
      mapElectionIdempotencyError(error);
    }
  }

  async registerCandidate(command: RegisterElectionCandidateCommand): Promise<ElectionItem> {
    const preliminary = await this.access.actor(command.actorUserId);
    this.access.assertTeacher(preliminary, "이 반의 선생님만 후보를 등록할 수 있어요.");
    assertPositiveElectionId(command.electionId);
    const expectedRowVersion = parseRequiredIfMatch(command.ifMatch);

    return this.database.transaction().execute(async (transaction) => {
      const actor = await this.access.lockActor(transaction, preliminary, command.actorUserId);
      this.access.assertTeacher(actor, "이 반의 선생님만 후보를 등록할 수 있어요.");

      const target = (await transaction
        .selectFrom("elections")
        .select(ELECTION_RETURNING)
        .where("class_id", "=", actor.classId)
        .where("id", "=", command.electionId)
        .forUpdate()
        .executeTakeFirst()) as ElectionRow | undefined;
      if (target === undefined) throw new ElectionNotFoundException();
      if (target.row_version !== expectedRowVersion) {
        throw new ResourceVersionChangedException(target.row_version);
      }
      /*
       * 투표가 시작된 뒤 후보가 늘면 먼저 찍은 학생과 나중에 찍은 학생이 서로 다른
       * 선택지를 본 셈이 된다. 준비 중일 때만 받는다.
       */
      if (target.status !== "draft") throw new ElectionStatusConflictException();

      const member = await transaction
        .selectFrom("class_members as member")
        .innerJoin("users as user", "user.id", "member.user_id")
        .select([
          "member.display_name_in_class",
          "member.id",
          "member.student_number",
          "user.deleted_at",
          "user.display_name",
          "user.is_active",
        ])
        .where("member.id", "=", command.memberId)
        .where("member.class_id", "=", actor.classId)
        .where("member.role", "=", "student")
        .where("member.status", "=", "approved")
        .executeTakeFirst();
      if (member === undefined || !member.is_active || member.deleted_at !== null) {
        throw new ElectionInvalidException("이 반의 승인된 학생만 후보로 등록할 수 있습니다.");
      }

      const existing = await transaction
        .selectFrom("election_candidates")
        .select(["id"])
        .where("election_id", "=", target.id)
        .where("member_id", "=", command.memberId)
        .executeTakeFirst();
      if (existing !== undefined) throw new ElectionCandidateAlreadyRegisteredException();

      const registered = await transaction
        .selectFrom("election_candidates")
        .select(({ fn }) => [fn.countAll<string>().as("total")])
        .where("election_id", "=", target.id)
        .executeTakeFirstOrThrow();
      if (Number(registered.total) >= MAX_ELECTION_CANDIDATES) {
        throw new ElectionInvalidException(
          `후보는 ${String(MAX_ELECTION_CANDIDATES)}명까지 등록할 수 있습니다.`,
        );
      }

      const candidate = await insertElectionCandidate(
        transaction,
        {
          class_id: actor.classId,
          display_name_snapshot: member.display_name_in_class ?? member.display_name,
          election_id: target.id,
          member_id: command.memberId,
          student_number_snapshot: member.student_number,
        },
        this.engine,
      );

      /* 후보가 생기는 순간 득표 칸도 만든다. 투표할 때 만들면 그때 경합이 생긴다. */
      await transaction
        .insertInto("election_tallies")
        .values({ candidate_id: candidate.id, election_id: target.id })
        .execute();

      const updated = await updateElection(
        transaction,
        target.id,
        { row_version: sql`row_version + 1` },
        this.engine,
      );

      await this.writeAudit(transaction, {
        action: "election.candidate_registered",
        actor,
        actorUserId: command.actorUserId,
        requestId: command.requestId,
        targetId: target.id,
      });

      return this.itemForRow(transaction, updated);
    });
  }

  /*
   * 학생·교사 공용. 학생이 「투표」를 열었을 때 볼 선거 하나를 고른다.
   *
   * 투표할 수 있는 것이 먼저다. 없으면 **가장 최근에 발표된 선거**를 준다 —
   * 교사가 "학생에게 공개"를 골라도 학생 화면에 그 결과를 부르는 곳이 없어서
   * 그 설정이 빈말이었다(2026-08-22 감사 BLUE-09, T-HUB-45). 결과 자체는 여기서
   * 싣지 않는다. 화면이 `status` 를 보고 결과 API 를 따로 부른다 — 공개 범위 판단은
   * 그쪽 한 곳에만 두는 편이 안전하다.
   *
   * 마감했지만 아직 발표 전(`closed`)인 것은 주지 않는다. 교사가 아직 안 알린 결과다.
   */
  async current(query: GetCurrentElectionQuery): Promise<ElectionCurrentResult> {
    const actor = await this.access.actor(query.actorUserId);
    const findLatest = async (status: "open" | "published"): Promise<ElectionRow | undefined> =>
      (await this.database
        .selectFrom("elections")
        .select(ELECTION_RETURNING)
        .where("class_id", "=", actor.classId)
        .where("status", "=", status)
        .orderBy("id", "desc")
        .executeTakeFirst()) as ElectionRow | undefined;
    const row = (await findLatest("open")) ?? (await findLatest("published"));
    if (row === undefined) return { item: null };

    const item = await this.itemForRow(this.database, row);
    const voted = await this.database
      .selectFrom("election_participants")
      .select(["member_id"])
      .where("election_id", "=", row.id)
      .where("member_id", "=", actor.memberId)
      .executeTakeFirst();
    return {
      item: {
        candidates: item.candidates,
        has_voted: voted !== undefined,
        id: item.id,
        participant_count: item.participant_count,
        status: item.status,
        title: item.title,
      },
    };
  }

  async open(command: OpenElectionCommand): Promise<ElectionItem> {
    const preliminary = await this.access.actor(command.actorUserId);
    this.access.assertTeacher(preliminary, "이 반의 선생님만 투표를 시작할 수 있어요.");
    assertPositiveElectionId(command.electionId);
    const expectedRowVersion = parseRequiredIfMatch(command.ifMatch);

    return this.database.transaction().execute(async (transaction) => {
      const startedAt =
        this.engine === "mariadb" ? await this.readDatabaseNow(transaction) : undefined;
      const actor = await this.access.lockActor(transaction, preliminary, command.actorUserId);
      this.access.assertTeacher(actor, "이 반의 선생님만 투표를 시작할 수 있어요.");

      const target = (await transaction
        .selectFrom("elections")
        .select(ELECTION_RETURNING)
        .where("class_id", "=", actor.classId)
        .where("id", "=", command.electionId)
        .forUpdate()
        .executeTakeFirst()) as ElectionRow | undefined;
      if (target === undefined) throw new ElectionNotFoundException();
      if (target.row_version !== expectedRowVersion) {
        throw new ResourceVersionChangedException(target.row_version);
      }
      if (target.status !== "draft") {
        throw new ElectionStatusConflictException("준비 중인 선거만 시작할 수 있습니다.");
      }

      /* 후보가 한 명이면 고를 것이 없다. 선거의 모양만 갖춘 형식이 되어 버린다. */
      const candidateCount = await transaction
        .selectFrom("election_candidates")
        .select(({ fn }) => [fn.countAll<string>().as("total")])
        .where("election_id", "=", target.id)
        .executeTakeFirstOrThrow();
      if (Number(candidateCount.total) < 2) {
        throw new ElectionInvalidException("후보를 두 명 이상 등록한 뒤에 시작할 수 있습니다.");
      }

      const now = startedAt ?? (await this.readDatabaseNow(transaction));
      const opened = await updateElection(
        transaction,
        target.id,
        { opened_at: now, row_version: sql`row_version + 1`, status: "open" },
        this.engine,
      );

      await this.writeAudit(transaction, {
        action: "election.opened",
        actor,
        actorUserId: command.actorUserId,
        requestId: command.requestId,
        targetId: target.id,
      });

      return this.itemForRow(transaction, opened);
    });
  }

  /*
   * 한 표를 던진다. 하는 일은 **둘뿐**이어야 한다 — 득표 수를 올리고, 투표했다는
   * 사실만 남긴다. 어떤 경로로도 "누가 무엇을" 형태의 값을 만들지 않는다.
   *
   * ⚠️ 멱등성 키를 일부러 쓰지 않는다. `api_idempotency_keys`는 한 행에
   * `actor_user_id`와 **요청 본문의 해시**를 함께 남기는데, 후보가 몇 명뿐이라
   * 해시를 하나씩 맞춰 보면 누가 누구를 뽑았는지 복원된다(2026-08-11 실측).
   * 중복 투표는 참여 표의 기본키가 막는다 — 그쪽이 안전하고 확실하다.
   * 대가: 성공 직후 재시도하면 "이미 투표했어요"가 뜬다. 조용히 성공한 척하는
   * 것보다 낫다.
   */
  async vote(command: CastElectionVoteCommand): Promise<ElectionCurrentResult> {
    const preliminary = await this.access.actor(command.actorUserId);
    if (preliminary.role !== "student") {
      throw new ElectionRoleInsufficientException("학생만 투표할 수 있습니다.");
    }
    assertPositiveElectionId(command.electionId);

    await this.database.transaction().execute(async (transaction) => {
      const actor = await this.access.lockActor(transaction, preliminary, command.actorUserId);
      if (actor.role !== "student") {
        throw new ElectionRoleInsufficientException("학생만 투표할 수 있습니다.");
      }

      const target = (await transaction
        .selectFrom("elections")
        .select(ELECTION_RETURNING)
        .where("class_id", "=", actor.classId)
        .where("id", "=", command.electionId)
        .executeTakeFirst()) as ElectionRow | undefined;
      if (target === undefined) throw new ElectionNotFoundException();
      if (target.status !== "open") throw new ElectionNotOpenException();

      const candidate = await transaction
        .selectFrom("election_candidates")
        .select(["id"])
        .where("election_id", "=", target.id)
        .where("id", "=", command.candidateId)
        .executeTakeFirst();
      if (candidate === undefined) {
        throw new ElectionInvalidException("이 선거의 후보가 아닙니다.");
      }

      /*
       * 참여 기록을 먼저 넣는다. 기본키가 중복 투표를 막으므로, 여기서 막히면
       * 득표 수는 손대지 않은 채 트랜잭션이 통째로 되돌아간다.
       */
      const alreadyVoted = await transaction
        .selectFrom("election_participants")
        .select(["member_id"])
        .where("election_id", "=", target.id)
        .where("member_id", "=", actor.memberId)
        .executeTakeFirst();
      if (alreadyVoted !== undefined) throw new ElectionAlreadyVotedException();

      await transaction
        .insertInto("election_participants")
        .values({ class_id: actor.classId, election_id: target.id, member_id: actor.memberId })
        .execute();

      await transaction
        .updateTable("election_tallies")
        .set({ vote_count: sql`vote_count + 1` })
        .where("election_id", "=", target.id)
        .where("candidate_id", "=", command.candidateId)
        .execute();
    });

    /* 응답에도 선택을 담지 않는다. 학생 화면이 필요한 것은 "했다"까지다. */
    return this.current({ actorUserId: command.actorUserId });
  }

  async close(command: CloseElectionCommand): Promise<ElectionItem> {
    const preliminary = await this.access.actor(command.actorUserId);
    this.access.assertTeacher(preliminary, "이 반의 선생님만 투표를 마감할 수 있어요.");
    assertPositiveElectionId(command.electionId);
    const expectedRowVersion = parseRequiredIfMatch(command.ifMatch);

    return this.database.transaction().execute(async (transaction) => {
      const startedAt =
        this.engine === "mariadb" ? await this.readDatabaseNow(transaction) : undefined;
      const actor = await this.access.lockActor(transaction, preliminary, command.actorUserId);
      this.access.assertTeacher(actor, "이 반의 선생님만 투표를 마감할 수 있어요.");

      const target = (await transaction
        .selectFrom("elections")
        .select(ELECTION_RETURNING)
        .where("class_id", "=", actor.classId)
        .where("id", "=", command.electionId)
        .forUpdate()
        .executeTakeFirst()) as ElectionRow | undefined;
      if (target === undefined) throw new ElectionNotFoundException();
      if (target.row_version !== expectedRowVersion) {
        throw new ResourceVersionChangedException(target.row_version);
      }
      if (target.status !== "open") {
        throw new ElectionStatusConflictException("진행 중인 선거만 마감할 수 있습니다.");
      }

      const now = startedAt ?? (await this.readDatabaseNow(transaction));
      const closed = await updateElection(
        transaction,
        target.id,
        { closed_at: now, row_version: sql`row_version + 1`, status: "closed" },
        this.engine,
      );

      await this.writeAudit(transaction, {
        action: "election.closed",
        actor,
        actorUserId: command.actorUserId,
        requestId: command.requestId,
        targetId: target.id,
      });

      return this.itemForRow(transaction, closed);
    });
  }

  async results(query: GetElectionResultsQuery): Promise<ElectionResults> {
    const actor = await this.access.actor(query.actorUserId);
    assertPositiveElectionId(query.electionId);
    const row = (await this.database
      .selectFrom("elections")
      .select(ELECTION_RETURNING)
      .where("class_id", "=", actor.classId)
      .where("id", "=", query.electionId)
      .executeTakeFirst()) as ElectionRow | undefined;
    if (row === undefined) throw new ElectionNotFoundException();
    /* 학생은 발표된 뒤에만 결과를 본다. 그전에는 선거가 있다는 것조차 결과로 알리지 않는다. */
    if (actor.role !== "teacher" && row.status !== "published") {
      throw new ElectionNotFoundException("아직 발표되지 않은 선거입니다.");
    }
    return this.resultsForRow(this.database, row, actor.role === "teacher");
  }

  async publish(command: PublishElectionCommand): Promise<ElectionResults> {
    const preliminary = await this.access.actor(command.actorUserId);
    this.access.assertTeacher(preliminary, "이 반의 선생님만 결과를 발표할 수 있어요.");
    assertPositiveElectionId(command.electionId);
    const expectedRowVersion = parseRequiredIfMatch(command.ifMatch);

    return this.database.transaction().execute(async (transaction) => {
      const startedAt =
        this.engine === "mariadb" ? await this.readDatabaseNow(transaction) : undefined;
      const actor = await this.access.lockActor(transaction, preliminary, command.actorUserId);
      this.access.assertTeacher(actor, "이 반의 선생님만 결과를 발표할 수 있어요.");

      const target = (await transaction
        .selectFrom("elections")
        .select(ELECTION_RETURNING)
        .where("class_id", "=", actor.classId)
        .where("id", "=", command.electionId)
        .forUpdate()
        .executeTakeFirst()) as ElectionRow | undefined;
      if (target === undefined) throw new ElectionNotFoundException();
      if (target.row_version !== expectedRowVersion) {
        throw new ResourceVersionChangedException(target.row_version);
      }
      if (target.status !== "closed") {
        throw new ElectionStatusConflictException("마감한 선거만 발표할 수 있습니다.");
      }

      const leaders = await this.leadingCandidates(transaction, target.id);
      if (leaders.length === 0) {
        throw new ElectionInvalidException("표가 하나도 없어 발표할 수 없습니다.");
      }

      let winnerCandidateId = leaders[0]!;
      let tieBreakApplied = false;
      if (leaders.length > 1) {
        /*
         * 동표 처리 방식은 선거를 만들 때 정해졌고 바뀌지 않았다(트리거가 막는다).
         * 그 방식대로만 처리한다 — 결과를 보고 규칙을 고르면 선거가 아니다.
         */
        if (target.tie_break === "revote") throw new ElectionRevoteRequiredException();
        if (command.winnerCandidateId === undefined) {
          throw new ElectionTieBreakRequiredException(
            target.tie_break === "elder"
              ? "동점입니다. 동점자 중 나이가 많은 학생을 골라 주세요."
              : "동점입니다. 선생님이 당선자를 골라 주세요.",
          );
        }
        if (!leaders.includes(command.winnerCandidateId)) {
          throw new ElectionTieBreakRequiredException("동점자 중에서만 고를 수 있습니다.");
        }
        winnerCandidateId = command.winnerCandidateId;
        tieBreakApplied = true;
      }

      const now = startedAt ?? (await this.readDatabaseNow(transaction));
      const published = await updateElection(
        transaction,
        target.id,
        {
          published_at: now,
          row_version: sql`row_version + 1`,
          status: "published",
          tie_break_applied: tieBreakApplied,
          winner_candidate_id: winnerCandidateId,
        },
        this.engine,
      );

      await this.writeAudit(transaction, {
        action: "election.published",
        actor,
        actorUserId: command.actorUserId,
        requestId: command.requestId,
        targetId: target.id,
      });

      return this.resultsForRow(transaction, published, true);
    });
  }

  /** 최다 득표 후보들. 하나면 그대로 당선, 여럿이면 동표다. */
  private async leadingCandidates(
    executor: ClassHubDatabase | Transaction<DB>,
    electionId: string,
  ): Promise<string[]> {
    const rows = await executor
      .selectFrom("election_tallies")
      .select(["candidate_id", "vote_count"])
      .where("election_id", "=", electionId)
      .execute();
    const best = rows.reduce((top, row) => Math.max(top, row.vote_count), 0);
    if (best === 0) return [];
    return rows.filter((row) => row.vote_count === best).map((row) => row.candidate_id);
  }

  private async resultsForRow(
    executor: ClassHubDatabase | Transaction<DB>,
    row: ElectionRow,
    forTeacher: boolean,
  ): Promise<ElectionResults> {
    const item = await this.itemForRow(executor, row);
    const counts = await executor
      .selectFrom("election_tallies")
      .select(["candidate_id", "vote_count"])
      .where("election_id", "=", row.id)
      .execute();
    const countByCandidate = new Map(counts.map((count) => [count.candidate_id, count.vote_count]));
    const tallies = item.candidates
      .map((candidate) => ({
        candidate_id: candidate.id,
        display_name: candidate.display_name,
        student_number: candidate.student_number,
        vote_count: countByCandidate.get(candidate.id) ?? 0,
      }))
      .sort((left, right) => right.vote_count - left.vote_count);
    const summary = electionSummary(row);
    const winnerId = row.winner_candidate_id;
    /*
     * **개표 전에는 아무도 중간 집계를 못 본다 — 교사도.**
     *
     * 학생에게 "누구를 뽑았는지는 아무도 알 수 없어요. 선생님도"라고 약속했고
     * (`student-election-vote.tsx`), 교사 화면도 진행 중에는 결과를 아예 안 부른다
     * (`teacher-election-panel.tsx` 주석: "결과는 마감한 뒤에만 불러온다").
     * 그런데 **서버가 그 약속을 안 받치고 있었다** — API 를 직접 부르면 진행 중에도
     * 집계가 나왔고, 한 학생이 찍기 전후로 두 번 부르면 그 학생의 선택을 알 수 있다
     * (2026-08-22 감사 BLUE-01, T-HUB-40). 교실은 누가 방금 투표했는지 다 보이는 곳이다.
     *
     * 참여자 수는 그대로 준다 — 몇 명이 찍었는지는 학생에게도 보이는 값이고
     * 그것만으로는 누구의 선택도 알 수 없다.
     */
    const counted = row.status === "closed" || row.status === "published";
    /* 득표 수를 누구에게 보일지는 선거 만들 때 정한 값이 정한다(교사는 개표 뒤 항상 본다). */
    const showTallies = counted && (forTeacher || summary.results_visibility === "with_counts");
    return {
      leading_candidate_ids: counted ? await this.leadingCandidates(executor, row.id) : [],
      participant_count: item.participant_count,
      results_visibility: summary.results_visibility,
      status: summary.status,
      tallies: showTallies ? tallies : null,
      tie_break: summary.tie_break,
      tie_break_applied: row.tie_break_applied,
      title: summary.title,
      winner:
        winnerId === null
          ? null
          : (item.candidates.find((candidate) => candidate.id === winnerId) ?? null),
    };
  }

  private async readDatabaseNow(transaction: Transaction<DB>): Promise<Date | RawBuilder<Date>> {
    if (this.engine === "mariadb") {
      // Capture once before lock waits, approximating PostgreSQL transaction time.
      // Bind the original six digits; public summaries still serialize Date/ISO3.
      const row = await sql<{
        election_now: string;
      }>`SELECT UTC_TIMESTAMP(6) AS election_now`.execute(transaction);
      return mariaDbDateBinding(row.rows[0]?.election_now);
    }
    const row = await sql<{ now: Date }>`SELECT now() AS now`.execute(transaction);
    return row.rows[0]!.now;
  }

  private async itemForRow(
    executor: ClassHubDatabase | Transaction<DB>,
    row: ElectionRow,
  ): Promise<ElectionItem> {
    const candidates = (await executor
      .selectFrom("election_candidates")
      .select(["display_name_snapshot", "id", "student_number_snapshot"])
      .where("election_id", "=", row.id)
      .$if(this.engine === "mariadb", (query) =>
        query.orderBy(sql`student_number_snapshot IS NULL`, "asc"),
      )
      .orderBy("student_number_snapshot", "asc")
      .orderBy("id", "asc")
      .execute()) as ElectionCandidateRow[];
    const participants = await executor
      .selectFrom("election_participants")
      .select(({ fn }) => [fn.countAll<string>().as("total")])
      .where("election_id", "=", row.id)
      .executeTakeFirstOrThrow();
    return {
      ...electionSummary(row),
      candidates: candidates.map((candidate) => ({
        display_name: candidate.display_name_snapshot,
        id: candidate.id,
        student_number: candidate.student_number_snapshot,
      })),
      participant_count: Number(participants.total),
    };
  }

  /*
   * 감사에 JSON 스냅샷을 싣지 않는다. 누가·무엇을·언제는 별도 칼럼에 남고,
   * 선거는 그 이상을 남기면 안 된다 — 개별 선택이 새어 나갈 통로를 만들지 않는다.
   * 덤으로 허용목록 CHECK를 다시 쓸 필요도 없다(NULL은 통과한다).
   */
  private async writeAudit(
    transaction: Transaction<DB>,
    entry: {
      action: string;
      actor: ElectionActorContext;
      actorUserId: string;
      requestId: string;
      targetId: string;
    },
  ): Promise<void> {
    await transaction
      .insertInto("audit_logs")
      .values({
        action: entry.action,
        actor_display_name_snapshot: entry.actor.displayName,
        actor_member_id: entry.actor.memberId,
        actor_role_snapshot: "teacher",
        actor_user_id: entry.actorUserId,
        after_json: null,
        before_json: null,
        class_id: entry.actor.classId,
        reason: null,
        request_id: entry.requestId,
        target_id: entry.targetId,
        target_snapshot: null,
        target_type: "election",
      })
      .execute();
  }
}
