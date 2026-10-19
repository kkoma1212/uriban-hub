import { AsyncResource } from "node:async_hooks";
import type { MariaDbPoolFactory } from "./connection.js";

type Pool = ReturnType<MariaDbPoolFactory>;
type AcquireCallback = Parameters<Pool["getConnection"]>[0];
type Raw = Parameters<AcquireCallback>[1];
export type MariaDbPoolFailureReason =
  | "configuration"
  | "connection"
  | "connection_queue_full"
  | "connection_timeout"
  | "query_timeout"
  | "closed"
  | "cleanup"
  | "role"
  | "readiness";
export class WorkerMariaDbDatabaseError extends Error {
  readonly code = "WORKER_MARIADB_DATABASE_FAILED";
  constructor(readonly reason: MariaDbPoolFailureReason) {
    super("워커 MariaDB 연결 작업을 완료하지 못했습니다.");
    this.name = "WorkerMariaDbDatabaseError";
  }
}
const timeoutMs = 5000;
/*
 * 연결을 기다리는 요청의 최대 수. 넘치면 바로 connection_queue_full로 거절한다. 64는 반 전체(100명)가
 * 동시에 첫 화면을 열 때 26명을 즉시 거절했다(연결 10 + 대기 64 = 74, 2026-09-28 실측). 세션 확인이 잠금 없는
 * 조회 한 번으로 가벼워져 대기는 수십 ms면 끝나므로 512로 늘린다. 과부하는 여전히 5초 획득 시한이 끊는다.
 */
export const MARIADB_MAXIMUM_QUEUED_ACQUISITIONS = 512;
const maximumQueuedAcquisitions = MARIADB_MAXIMUM_QUEUED_ACQUISITIONS;
type Reservation = {
  deadline: number;
  statementSeconds: number;
  callback: AcquireCallback | undefined;
  context: AsyncResource | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  phase: "queued" | "acquiring" | "bootstrapping" | "leased" | "ended";
  permit: boolean;
  nativePending: boolean;
  physical: Physical | undefined;
};
type Physical = {
  raw: Raw;
  destroyed: boolean;
  owner: Reservation | undefined;
  pending: Set<() => void>;
};

/** Private adapter bootstrap. Business/control SQL is forwarded unchanged; the pool is never shared. */
export function boundedMariaDbPoolFactory(
  createPool: MariaDbPoolFactory,
  readinessLease: () => boolean,
  onUnexpectedPoolError?: () => void,
  makeError: (reason: MariaDbPoolFailureReason) => Error = (reason) =>
    new WorkerMariaDbDatabaseError(reason),
  queryTimeoutMs: 5000 | 10000 = 5000,
): MariaDbPoolFactory {
  // Retention preserves its reviewed ten-second SQL budget; acquisition/shutdown remain five.
  if (queryTimeoutMs !== 5000 && queryTimeoutMs !== 10000) throw makeError("configuration");
  return (configuration) => {
    const limit = configuration.connectionLimit;
    if (!Number.isSafeInteger(limit) || limit < 1) throw makeError("configuration");
    const pool = createPool({
        ...configuration,
        waitForConnections: false,
        queueLimit: 0,
        resetOnRelease: false,
      }),
      physicals = new Set<Physical>(),
      known = new WeakMap<Raw, Physical>(),
      waiting = new Set<Reservation>(),
      queued = new Set<Reservation>();
    let closing = false,
      setupFailed = false,
      pumping = false,
      pumpScheduled = false,
      invokingCallback = false,
      permits = 0,
      ended = false;
    let endError: unknown;
    const endCallbacks: ((error: unknown) => void)[] = [];
    const notify = () => {
      try {
        onUnexpectedPoolError?.();
      } catch {
        /* Observer receives no native error or credentials. */
      }
    };
    const events = pool as Pool & { on?: (event: "error", listener: () => void) => unknown };
    try {
      events.on?.("error", notify);
    } catch {
      setupFailed = true;
    }
    function schedulePump() {
      if (closing || setupFailed || pumpScheduled || queued.size === 0) return;
      pumpScheduled = true;
      queueMicrotask(() => {
        pumpScheduled = false;
        pump();
      });
    }
    function returnPermit(reservation: Reservation) {
      if (!reservation.permit) return;
      reservation.permit = false;
      permits--;
      schedulePump();
    }
    function destroy(physical: Physical, firstFailure?: () => void) {
      if (physical.destroyed) return;
      physical.destroyed = true;
      physicals.delete(physical);
      const owner = physical.owner;
      physical.owner = undefined;
      if (owner) owner.phase = "ended";
      // Settle the watchdog first: destroy() may synchronously report a native
      // query failure, but neither callback can return this unusable socket.
      firstFailure?.();
      try {
        physical.raw.destroy();
      } catch {
        notify();
      }
      for (const cancel of [...physical.pending]) cancel();
      if (owner) {
        finish(owner, makeError("connection"));
        returnPermit(owner);
      }
    }
    function finish(reservation: Reservation, error: unknown, raw?: Raw) {
      const callback = reservation.callback;
      if (!callback) return;
      reservation.callback = undefined;
      const context = reservation.context;
      reservation.context = undefined;
      clearTimeout(reservation.timer);
      reservation.timer = undefined;
      waiting.delete(reservation);
      queued.delete(reservation);
      reservation.phase = error ? "ended" : "leased";
      if (error) {
        if (reservation.physical) destroy(reservation.physical);
        // A started native acquire has no public cancellation handle. Its permit
        // stays reserved until its callback, with at most L such records retained.
        else if (!reservation.nativePending) returnPermit(reservation);
      }
      const wasInvoking = invokingCallback;
      invokingCallback = true;
      try {
        context!.runInAsyncScope(callback, undefined, error, raw as Raw);
      } catch {
        notify();
        if (reservation.physical) destroy(reservation.physical);
      } finally {
        invokingCallback = wasInvoking;
        context!.emitDestroy();
      }
    }
    function attach(reservation: Reservation, raw: Raw): Physical | undefined {
      let physical = known.get(raw);
      // An invalid factory must not lend a physical connection twice or revive it.
      if (physical?.destroyed || physical?.owner) return undefined;
      if (physical) {
        physical.owner = reservation;
        reservation.physical = physical;
        return physical;
      }
      physical = { raw, destroyed: false, owner: reservation, pending: new Set() };
      reservation.physical = physical;
      known.set(raw, physical);
      physicals.add(physical);
      const created = physical;
      try {
        (raw as Raw & { on?: (event: "error", listener: () => void) => unknown }).on?.(
          "error",
          () => {
            notify();
            destroy(created);
          },
        );
      } catch {
        destroy(created);
      }
      return physical;
    }
    function connection(reservation: Reservation, physical: Physical): Raw {
      const owns = () =>
        !physical.destroyed && physical.owner === reservation && reservation.phase !== "ended";
      return {
        ...(typeof physical.raw.readRuntimeTls === "function"
          ? {
              readRuntimeTls: () => {
                if (closing || !owns()) throw makeError("closed");
                return physical.raw.readRuntimeTls!();
              },
            }
          : {}),
        query(statement, parameters, callback) {
          if (closing || !owns()) {
            callback(makeError("closed"), undefined);
            return;
          }
          let done = false;
          const complete = (error: unknown, result: unknown) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            physical.pending.delete(cancel);
            try {
              callback(error, result);
            } catch {
              notify();
              destroy(physical);
            }
          };
          const cancel = () => complete(makeError("closed"), undefined);
          const timer = setTimeout(
            () => destroy(physical, () => complete(makeError("query_timeout"), undefined)),
            queryTimeoutMs,
          );
          timer.unref();
          physical.pending.add(cancel);
          try {
            physical.raw.query(statement, parameters, complete);
          } catch (error) {
            complete(error, undefined);
          }
        },
        release() {
          if (!owns()) return;
          if (physical.pending.size > 0) {
            destroy(physical);
            return;
          }
          reservation.phase = "ended";
          physical.owner = undefined;
          try {
            physical.raw.release();
          } catch {
            destroy(physical);
            throw makeError("cleanup");
          } finally {
            returnPermit(reservation);
          }
        },
        destroy() {
          if (owns()) destroy(physical);
        },
      };
    }
    function dispatch(reservation: Reservation) {
      reservation.phase = "acquiring";
      reservation.permit = true;
      reservation.nativePending = true;
      permits++;
      let received = false;
      try {
        pool.getConnection((error, raw) => {
          // mysql2 promises one callback. Duplicate delivery must not destroy a
          // socket which this or a later lease has already received.
          if (received) return;
          received = true;
          reservation.nativePending = false;
          const physical = raw ? attach(reservation, raw) : undefined;
          if (!reservation.callback || closing || performance.now() >= reservation.deadline) {
            if (reservation.callback)
              finish(reservation, makeError(closing ? "closed" : "connection_timeout"));
            if (physical) destroy(physical);
            returnPermit(reservation);
            return;
          }
          if (error || !physical || physical.destroyed) {
            finish(reservation, makeError("connection"));
            return;
          }
          reservation.phase = "bootstrapping";
          const wrapped = connection(reservation, physical);
          // Session-local, before guarded reset/attestation; the original deadline
          // includes the application queue, native acquire and this bootstrap.
          wrapped.query(
            `SET SESSION max_statement_time = ${reservation.statementSeconds}`,
            [],
            (bootstrapError) => {
              if (!reservation.callback) return;
              if (closing || performance.now() >= reservation.deadline)
                finish(reservation, makeError(closing ? "closed" : "connection_timeout"));
              else if (bootstrapError) finish(reservation, makeError("connection"));
              else finish(reservation, null, wrapped);
            },
          );
        });
      } catch {
        if (!received) {
          reservation.nativePending = false;
          finish(reservation, makeError("connection"));
        } else notify();
      }
    }
    function removeExpired() {
      // Callbacks can re-enter admission, so deadline order need not match FIFO
      // insertion. Inspect at most Q entries and delete real nodes, not tombstones.
      for (const reservation of [...queued]) {
        if (performance.now() >= reservation.deadline)
          finish(reservation, makeError("connection_timeout"));
      }
    }
    function pump() {
      if (closing || setupFailed || pumping) return;
      if (invokingCallback) {
        schedulePump();
        return;
      }
      pumping = true;
      try {
        removeExpired();
        while (!closing && permits < limit && queued.size > 0) {
          const reservation = queued.values().next().value!;
          queued.delete(reservation);
          if (performance.now() >= reservation.deadline)
            finish(reservation, makeError("connection_timeout"));
          else dispatch(reservation);
        }
      } finally {
        pumping = false;
      }
    }
    return {
      getConnection(callback) {
        if (closing || setupFailed) {
          callback(makeError("closed"), undefined as unknown as Raw);
          return;
        }
        // Retain the submitting request's readiness policy and callback context,
        // not the context of a different request which later returns a permit.
        const deadline = performance.now() + timeoutMs;
        const statementSeconds = readinessLease() ? 1 : queryTimeoutMs / 1000;
        removeExpired();
        // Expired callbacks may re-enter and close the pool while being settled.
        if (closing || setupFailed) {
          callback(makeError("closed"), undefined as unknown as Raw);
          return;
        }
        if (queued.size >= maximumQueuedAcquisitions) {
          callback(makeError("connection_queue_full"), undefined as unknown as Raw);
          return;
        }
        const reservation: Reservation = {
          deadline,
          statementSeconds,
          callback,
          context: new AsyncResource("MariaDbPoolAcquire", { requireManualDestroy: true }),
          timer: undefined,
          phase: "queued",
          permit: false,
          nativePending: false,
          physical: undefined,
        };
        reservation.timer = setTimeout(
          () => finish(reservation, makeError("connection_timeout")),
          Math.max(0, deadline - performance.now()),
        );
        reservation.timer.unref();
        waiting.add(reservation);
        queued.add(reservation);
        pump();
      },
      end(callback) {
        if (ended) {
          callback(endError);
          return;
        }
        endCallbacks.push(callback);
        if (closing) return;
        closing = true;
        for (const reservation of [...waiting]) finish(reservation, makeError("closed"));
        const complete = (error: unknown) => {
          if (ended) return;
          ended = true;
          endError = error ? makeError("cleanup") : null;
          clearTimeout(timer);
          for (const physical of physicals) destroy(physical);
          for (const done of endCallbacks.splice(0)) {
            try {
              done(endError);
            } catch {
              notify();
            }
          }
        };
        const timer = setTimeout(() => complete(makeError("cleanup")), timeoutMs);
        timer.unref();
        try {
          pool.end(complete);
        } catch {
          complete(makeError("cleanup"));
        }
      },
    };
  };
}
