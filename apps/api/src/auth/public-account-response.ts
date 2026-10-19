import { performance } from "node:perf_hooks";

// Covers short database-path differences without busy-waiting or releasing an
// unfinished mutation. Slow SMTP/DB work can exceed this floor; this is not a
// constant-time guarantee and does not replace the durable mail outbox.
export const ACCOUNT_RESPONSE_FLOOR_MS = 500;

export async function publicAccountResponse<T>(operation: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await operation();
  } finally {
    const remaining = ACCOUNT_RESPONSE_FLOOR_MS - (performance.now() - started);
    if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  }
}
