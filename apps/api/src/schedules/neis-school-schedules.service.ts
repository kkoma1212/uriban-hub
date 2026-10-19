import { createHash } from "node:crypto";

import { fetchNeisSchoolSchedules } from "@classhub/neis";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { addCalendarDays } from "../common/date/kst-date.js";
import type { AppEnvironment } from "../config/environment.js";
import type { SchoolScheduleViewRow } from "./schedules.view.js";

interface School {
  eduOfficeCode: string;
  schoolCode: string;
}

interface CachedYear {
  expiresAt: number;
  rows: SchoolScheduleViewRow[];
}

// 학교가 학사일정을 바꾸면 몇 시간 안에 보이게 한다. 비어 있으면 곧 다시 묻는다.
const FRESH_MS = 6 * 60 * 60_000;
const EMPTY_MS = 30 * 60_000;
const CACHE_LIMIT = 128;

/**
 * 학사일정 바로 가져오기(2026-09-30 사용자 결정 — 급식처럼). 학년도(3월~다음 2월) 단위로 나이스에서
 * 받아 잠시 기억한다. 키가 없거나 나이스가 응답하지 않으면 undefined — 호출한 쪽이 저장된 일정으로 보인다.
 * 공개 자료만 오가며 계정 정보는 나이스에 보내지 않는다.
 */
@Injectable()
export class NeisSchoolSchedulesService {
  private readonly cache = new Map<string, CachedYear>();
  private readonly pending = new Map<string, Promise<SchoolScheduleViewRow[] | undefined>>();

  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  async academicYear(
    school: School,
    academicYear: number,
  ): Promise<SchoolScheduleViewRow[] | undefined> {
    const apiKey = this.config.get("NEIS_API_KEY", { infer: true });
    if (apiKey === undefined) return undefined;
    const key = `${school.eduOfficeCode}:${school.schoolCode}:${academicYear}`;
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.rows;
    const existing = this.pending.get(key);
    if (existing !== undefined) return existing;

    const request = this.load(school, academicYear, apiKey).then((rows) => {
      if (rows === undefined) return undefined;
      this.cache.delete(key);
      if (this.cache.size >= CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, {
        expiresAt: Date.now() + (rows.length === 0 ? EMPTY_MS : FRESH_MS),
        rows,
      });
      return rows;
    });
    this.pending.set(key, request);
    try {
      return await request;
    } finally {
      this.pending.delete(key);
    }
  }

  private async load(
    school: School,
    academicYear: number,
    apiKey: string,
  ): Promise<SchoolScheduleViewRow[] | undefined> {
    const from = `${academicYear}-03-01`;
    const to = addCalendarDays(`${academicYear + 1}-03-01`, -1);
    try {
      const events = await fetchNeisSchoolSchedules(
        { ...school, apiKey, from, to },
        { timeoutMs: 3_000, retryDelayMs: 100 },
      );
      return events
        .filter((event) => event.academicYear === academicYear)
        .map((event) => ({
          // 날짜·행사명·대상 학년이 같으면 같은 행사다(저장본의 자연키와 같은 기준) — 고정 번호를 만든다.
          id: String(
            (createHash("sha256")
              .update(
                `neis-school:${event.eduOfficeCode}:${event.schoolCode}:${event.academicYear}:${event.eventDate}:${event.eventName}:${event.gradeMask}`,
              )
              .digest()
              .readBigUInt64BE(0) >>
              1n) +
              1n,
          ),
          event_content: event.eventContent,
          event_date: event.eventDate,
          event_name: event.eventName,
          grade_mask: event.gradeMask,
          school_day_type: event.schoolDayType,
          source_loaded_on: event.sourceLoadedOn,
        }));
    } catch {
      return undefined;
    }
  }
}
