import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import { AUTH_RATE_LIMITER } from "../auth/auth.tokens.js";
import type { RedisRateLimiter } from "../common/rate-limit/redis-rate-limiter.js";

export const CLIENT_ERROR_SOURCES = ["render", "script", "promise", "chunk"] as const;
export const CLIENT_ERROR_ROLES = ["student", "teacher", "unknown"] as const;
export const CLIENT_ERROR_DEVICES = ["phone", "desktop"] as const;

export interface ClientErrorReport {
  device: (typeof CLIENT_ERROR_DEVICES)[number];
  name: string;
  role: (typeof CLIENT_ERROR_ROLES)[number];
  route: string;
  source: (typeof CLIENT_ERROR_SOURCES)[number];
}

export interface ClientErrorKind extends ClientErrorReport {
  count: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface ClientErrorSummary {
  kinds: ClientErrorKind[];
  total: number;
  window_hours: number;
}

/** 시간 단위 묶음 하나에 건수(c:)·처음(f:)·마지막(l:) 시각을 쌓는 저장소. */
export interface ClientErrorBuckets {
  /** 묶음의 종류가 상한이면 쌓지 않고 false. */
  increment(key: string, field: string, at: number, maxKinds: number): Promise<boolean>;
  read(keys: string[]): Promise<Array<Record<string, string>>>;
}

export const CLIENT_ERROR_BUCKETS = Symbol("CLIENT_ERROR_BUCKETS");

/*
 * 휴대폰 화면 오류 모으기(T-CLIENT-ERRORS, 2026-10-05 사용자 결정: 로그인한 사람만·DB 표 없이).
 * 처음엔 서버 메모리에 뒀으나 운영(3000)과 공개 미리보기(3301) API가 따로 떠서 휴대폰 오류가
 * 관리자 화면에 안 보였다(2026-10-05 실측) → 두 API가 같이 쓰는 Redis에 한 시간 묶음으로 쌓고
 * 25시간 뒤 저절로 지운다(사용자 선택). 진단용이지 보관 기록이 아니다.
 */
const WINDOW_HOURS = 24;
const BUCKET_MS = 60 * 60 * 1000;
const MAX_KINDS_PER_BUCKET = 200;
const MAX_KINDS_LISTED = 200;
const MAX_REPORTS_PER_SENDER = 30;
const SENDER_WINDOW_SECONDS = 60 * 60;
/** 주소 조각이 숫자거나 이만큼 길면 글 번호·초대 토큰 같은 값으로 보고 지운다. */
const MAX_PLAIN_SEGMENT = 24;

export function clientErrorBucketKey(at: number): string {
  return `classhub:client-errors:v1:${Math.floor(at / BUCKET_MS)}`;
}

/** 화면이 이미 지웠어도 한 번 더 — 숫자·긴 조각을 :id로 바꿔 개별 글·사람을 가리키지 않게 한다. */
export function normalizeClientErrorRoute(route: string): string {
  return route
    .split("/")
    .map((segment) =>
      /^[0-9]+$/u.test(segment) || segment.length > MAX_PLAIN_SEGMENT ? ":id" : segment,
    )
    .join("/");
}

/** 칸 값은 허용 목록·패턴을 통과한 것뿐이라 '|'가 들어올 수 없다. */
function kindField(report: ClientErrorReport): string {
  return [report.source, report.name, report.route, report.role, report.device].join("|");
}

function kindFromField(field: string): ClientErrorReport | undefined {
  const [source, name, route, role, device] = field.split("|");
  if (
    !CLIENT_ERROR_SOURCES.includes(source as ClientErrorReport["source"]) ||
    !CLIENT_ERROR_ROLES.includes(role as ClientErrorReport["role"]) ||
    !CLIENT_ERROR_DEVICES.includes(device as ClientErrorReport["device"]) ||
    name === undefined ||
    route === undefined
  )
    return undefined;
  return {
    device: device as ClientErrorReport["device"],
    name,
    role: role as ClientErrorReport["role"],
    route,
    source: source as ClientErrorReport["source"],
  };
}

@Injectable()
export class ClientErrorStore {
  constructor(
    @Inject(CLIENT_ERROR_BUCKETS) private readonly buckets: ClientErrorBuckets,
    @Inject(AUTH_RATE_LIMITER) private readonly rateLimiter: RedisRateLimiter,
  ) {}

  /** 한도를 넘었거나 묶음이 꽉 찼으면 false. 보낸 사람은 해시로 한도 계산에만 쓰고 남기지 않는다. */
  async record(
    senderId: string,
    input: ClientErrorReport,
    at: number = Date.now(),
  ): Promise<boolean> {
    const sender = createHash("sha256").update(senderId).digest("hex").slice(0, 32);
    const budget = await this.rateLimiter.consume({
      key: `classhub:client-errors:sender:${sender}`,
      limit: MAX_REPORTS_PER_SENDER,
      windowSeconds: SENDER_WINDOW_SECONDS,
    });
    if (!budget.allowed) return false;
    const report = { ...input, route: normalizeClientErrorRoute(input.route) };
    return this.buckets.increment(
      clientErrorBucketKey(at),
      kindField(report),
      at,
      MAX_KINDS_PER_BUCKET,
    );
  }

  /** 지금 묶음과 앞선 23개(최근 24시간 안팎)를 합친다. 한 시간 단위라 경계가 최대 1시간 넓다. */
  async summary(at: number = Date.now()): Promise<ClientErrorSummary> {
    const current = Math.floor(at / BUCKET_MS);
    const keys = Array.from({ length: WINDOW_HOURS }, (_, index) =>
      clientErrorBucketKey((current - index) * BUCKET_MS),
    );
    const merged = new Map<string, { count: number; first: number; last: number }>();
    for (const bucket of await this.buckets.read(keys)) {
      for (const [field, value] of Object.entries(bucket)) {
        if (!field.startsWith("c:")) continue;
        const kind = field.slice(2);
        const count = Number(value);
        const first = Number(bucket[`f:${kind}`]);
        const last = Number(bucket[`l:${kind}`]);
        if (!Number.isSafeInteger(count) || count <= 0) continue;
        const entry = merged.get(kind);
        if (entry === undefined) merged.set(kind, { count, first, last });
        else {
          entry.count += count;
          entry.first = Math.min(entry.first, first);
          entry.last = Math.max(entry.last, last);
        }
      }
    }
    const kinds = [...merged.entries()]
      .flatMap(([field, entry]) => {
        const report = kindFromField(field);
        if (report === undefined || !Number.isFinite(entry.first) || !Number.isFinite(entry.last))
          return [];
        return [
          {
            ...report,
            count: entry.count,
            first_seen_at: new Date(entry.first).toISOString(),
            last_seen_at: new Date(entry.last).toISOString(),
          },
        ];
      })
      .sort((a, b) => b.count - a.count || b.last_seen_at.localeCompare(a.last_seen_at))
      .slice(0, MAX_KINDS_LISTED);
    return {
      kinds,
      total: kinds.reduce((sum, kind) => sum + kind.count, 0),
      window_hours: WINDOW_HOURS,
    };
  }
}
