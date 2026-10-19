export class PasswordWorkCapacityError extends Error {
  constructor() {
    super("Password verification capacity is temporarily unavailable.");
    this.name = "PasswordWorkCapacityError";
  }
}

/** Bound native KDF work across login, signup, reset and administrator authentication. */
export class PasswordWorkLimiter {
  private active = 0;
  private readonly waiting: Array<{ start: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(
    private readonly concurrency = 4,
    private readonly maximumWaiting = 32,
    private readonly waitMs = 2_000,
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next === undefined) this.active -= 1;
      else {
        clearTimeout(next.timer);
        next.start();
      }
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.maximumWaiting) {
      return Promise.reject(new PasswordWorkCapacityError());
    }
    return new Promise((resolve, reject) => {
      const entry = {
        start: resolve,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(entry);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new PasswordWorkCapacityError());
        }, this.waitMs),
      };
      this.waiting.push(entry);
    });
  }
}
