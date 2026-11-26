/**
 * One queue for all traffic to the Internet Archive (web.archive.org, archive.org).
 *
 * The archive throttles clients that open several CDX and id_ requests at once. Everything that
 * talks to it (CDX, snapshot bodies, the availability API, and links under test whose host is the
 * archive) runs through one ArchiveQueue instance:
 *
 *   - one request at a time;
 *   - at least `minGapMs` between the starts of two requests;
 *   - `penalize(ms)` pushes the next start out for every waiter (Retry-After on a 429 or 503);
 *   - each request has its own timeout, counted from the moment it starts, not from the moment it
 *     was queued. A request that ignores its abort signal is still released when the timeout hits.
 *
 * No module-global mutable state except the resettable default used by the CLI and MCP door.
 * The Worker builds one queue per HTTP request. Time comes from an injectable clock, so tests
 * need no real timers.
 */

/** Minimum gap between request starts, per environment. */
export const ARCHIVE_MIN_GAP_MS = {
  /** CLI and MCP: no subrequest or CPU limit, so the archive's patience sets the pace. */
  node: 1000,
  /** Worker: three links per call and a browser waiting, so a shorter gap. */
  worker: 300,
} as const;

/** Per-request limit once the request has started. */
export const ARCHIVE_TIMEOUT_MS = 10_000;
/** Longest Retry-After honoured. */
export const MAX_RETRY_AFTER_MS = 10_000;

export interface ArchiveClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: ArchiveClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Thrown by `run` when a started request exceeded its timeout. */
export class ArchiveTimeoutError extends Error {
  constructor() {
    super('archive request timed out');
    this.name = 'ArchiveTimeoutError';
  }
}

export interface ArchiveQueue {
  readonly minGapMs: number;
  readonly clock: ArchiveClock;
  /**
   * Run `task` when it is its turn. The signal aborts `timeoutMs` after the task starts.
   * Rejects with the task's own error, or with ArchiveTimeoutError. Either way the queue moves on.
   */
  run<T>(task: (signal: AbortSignal) => Promise<T>, options?: { timeoutMs?: number }): Promise<T>;
  /** No request starts within `ms` from now (longest wins). Affects every waiter. */
  penalize(ms: number): void;
}

export interface ArchiveQueueOptions {
  minGapMs: number;
  clock?: ArchiveClock;
}

export function createArchiveQueue(options: ArchiveQueueOptions): ArchiveQueue {
  const clock = options.clock ?? realClock;
  const minGapMs = options.minGapMs;
  let tail: Promise<void> = Promise.resolve();
  let lastStart = -Infinity;
  let notBefore = -Infinity;
  const noop = (): void => {};
  const sleep = (ms: number): Promise<void> => new Promise(resolve => clock.setTimeout(resolve, ms));

  return {
    minGapMs,
    clock,

    penalize(ms: number): void {
      if (ms > 0) notBefore = Math.max(notBefore, clock.now() + ms);
    },

    run<T>(task: (signal: AbortSignal) => Promise<T>, opts?: { timeoutMs?: number }): Promise<T> {
      const timeoutMs = opts?.timeoutMs ?? ARCHIVE_TIMEOUT_MS;
      const exec = async (): Promise<T> => {
        // The previous request has finished: no other request can change the penalty now.
        const wait = Math.max(lastStart + minGapMs, notBefore) - clock.now();
        if (wait > 0) await sleep(wait);

        lastStart = clock.now();
        const controller = new AbortController();
        let timer: unknown;
        const timedOut = new Promise<never>((_, reject) => {
          timer = clock.setTimeout(() => {
            controller.abort();
            reject(new ArchiveTimeoutError());
          }, Math.max(0, timeoutMs));
        });
        try {
          return await Promise.race([task(controller.signal), timedOut]);
        } finally {
          clock.clearTimeout(timer);
        }
      };
      const result = tail.then(exec);
      tail = result.then(noop, noop);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Retry-After
// ---------------------------------------------------------------------------

/**
 * Milliseconds to wait from a Retry-After header (seconds or HTTP-date), capped at 10 s.
 * Undefined when the header is absent or unreadable.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | undefined {
  if (value === null || value === undefined) return undefined;
  const v = value.trim();
  if (v === '') return undefined;
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(v)) {
    ms = Number(v) * 1000;
  } else {
    const at = Date.parse(v);
    if (Number.isNaN(at)) return undefined;
    ms = at - nowMs;
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

// ---------------------------------------------------------------------------
// Which hosts belong to the archive
// ---------------------------------------------------------------------------

/** web.archive.org, archive.org and any *.archive.org host. */
export function isArchiveHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return h === 'archive.org' || h.endsWith('.archive.org');
}

// ---------------------------------------------------------------------------
// Default queue for the CLI and MCP door (resettable for tests)
// ---------------------------------------------------------------------------

let defaultQueue: ArchiveQueue | undefined;

/** One process-wide queue so every scan in a CLI or MCP process shares the archive's patience. */
export function defaultArchiveQueue(): ArchiveQueue {
  return (defaultQueue ??= createArchiveQueue({ minGapMs: ARCHIVE_MIN_GAP_MS.node }));
}

export function resetDefaultArchiveQueue(): void {
  defaultQueue = undefined;
}
