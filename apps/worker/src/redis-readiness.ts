interface RedisConnectionState {
  readonly isReady: boolean;
}

interface RedisReadinessConnection extends RedisConnectionState {
  ping(): Promise<string>;
}

/** Probe on a separate connection so the worker's blocking read cannot delay PING. */
export async function probeWorkerRedisReadiness(
  worker: RedisConnectionState,
  readiness: RedisReadinessConnection,
): Promise<void> {
  if (worker === readiness || !worker.isReady || !readiness.isReady) {
    throw new Error("Worker Redis connections are not ready.");
  }
  const response = await readiness.ping();
  if (response !== "PONG" || !worker.isReady || !readiness.isReady) {
    throw new Error("Worker Redis connections are not ready.");
  }
}
