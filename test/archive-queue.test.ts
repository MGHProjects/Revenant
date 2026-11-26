import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_MIN_GAP_MS,
  ArchiveTimeoutError,
  createArchiveQueue,
  defaultArchiveQueue,
  isArchiveHost,
  parseRetryAfter,
  resetDefaultArchiveQueue,
} from '../src/net/archive-queue.js';
import { FakeClock } from './fixtures/fake-clock.js';

// Task 18.3: one queue for all Internet Archive traffic. Injected clock, no real waiting.

function setup(minGapMs: number) {
  const clock = new FakeClock();
  const queue = createArchiveQueue({ minGapMs, clock });
  const starts: number[] = [];
  let active = 0;
  let maxActive = 0;
  /** A request that starts, holds for `holdMs` of fake time, then ends. */
  const request = (name: string, holdMs = 0, onStart?: () => void) =>
    queue.run(async () => {
      starts.push(clock.now());
      onStart?.();
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (holdMs > 0) await new Promise<void>(resolve => clock.setTimeout(resolve, holdMs));
      active -= 1;
      return name;
    });
  return { clock, queue, starts, request, maxActive: () => maxActive };
}

describe('archive queue', () => {
  it('never lets two requests overlap', async () => {
    const { clock, request, maxActive, starts } = setup(0);
    const all = Promise.all([request('a', 500), request('b', 500), request('c', 500)]);
    await clock.advance(2_000);
    expect(await all).toEqual(['a', 'b', 'c']);
    expect(maxActive()).toBe(1);
    expect(starts).toEqual([0, 500, 1000]);
  });

  it('keeps the minimum gap between request starts', async () => {
    const { clock, request, starts } = setup(1000);
    const all = Promise.all([request('a'), request('b'), request('c')]);
    await clock.advance(3_000);
    await all;
    expect(starts).toEqual([0, 1000, 2000]);
  });

  it('measures the gap from the start of the previous request, not from its end', async () => {
    const { clock, request, starts } = setup(1000);
    const all = Promise.all([request('a', 700), request('b')]);
    await clock.advance(3_000);
    await all;
    expect(starts).toEqual([0, 1000]);
  });

  it('Retry-After delays every waiter, not just the caller', async () => {
    const { clock, queue, request, starts } = setup(100);
    const a = request('a', 0, () => queue.penalize(5_000));
    const b = request('b');
    const c = request('c');
    await clock.advance(4_999);
    expect(starts).toEqual([0]);
    await clock.advance(1);
    expect(starts).toEqual([0, 5_000]);
    await clock.advance(200);
    expect(starts).toEqual([0, 5_000, 5_100]);
    await Promise.all([a, b, c]);
  });

  it('the longest of two penalties wins', async () => {
    const { clock, queue, request, starts } = setup(0);
    queue.penalize(3_000);
    queue.penalize(1_000);
    const a = request('a');
    await clock.advance(2_999);
    expect(starts).toEqual([]);
    await clock.advance(1);
    expect(starts).toEqual([3_000]);
    await a;
  });

  it('a throwing request rejects its caller and does not block the queue', async () => {
    const { clock, queue, request, starts } = setup(0);
    const bad = queue.run(async () => {
      throw new Error('boom');
    });
    const bad2 = expect(bad).rejects.toThrow('boom');
    const good = request('after');
    await clock.advance(10);
    await bad2;
    expect(await good).toBe('after');
    expect(starts).toEqual([0]);
  });

  it('starts the request timeout when the request starts, not when it was queued', async () => {
    const { clock, queue, request } = setup(1000);
    const first = request('first');
    let aborted = false;
    const second = queue
      .run(
        signal =>
          new Promise<string>((_, reject) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('aborted'));
            });
          }),
        { timeoutMs: 500 },
      )
      .catch((e: unknown) => e);
    // The second request waited 1000 ms in the queue, longer than its own 500 ms limit.
    await clock.advance(1_000);
    expect(aborted).toBe(false);
    await clock.advance(499);
    expect(aborted).toBe(false);
    await clock.advance(1);
    expect(aborted).toBe(true);
    await first;
    expect(await second).toBeInstanceOf(Error);
  });

  it('releases a request that ignores its abort signal once the timeout passes', async () => {
    const { clock, queue, request, starts } = setup(0);
    const hung = queue.run(() => new Promise<never>(() => {}), { timeoutMs: 10_000 }).catch((e: unknown) => e);
    const next = request('next');
    await clock.advance(9_999);
    expect(starts).toEqual([]);
    await clock.advance(1);
    expect(await hung).toBeInstanceOf(ArchiveTimeoutError);
    expect(await next).toBe('next');
  });

  it('shares nothing between two queues', async () => {
    const a = setup(1000);
    const b = setup(1000);
    const pa = Promise.all([a.request('x'), a.request('y')]);
    const pb = b.request('z');
    await b.clock.advance(0);
    expect(b.starts).toEqual([0]);
    await a.clock.advance(1_000);
    await Promise.all([pa, pb]);
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds', () => {
    expect(parseRetryAfter('3', 0)).toBe(3_000);
    expect(parseRetryAfter(' 1.5 ', 0)).toBe(1_500);
  });
  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:04 GMT', now)).toBe(4_000);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:27:00 GMT', now)).toBe(0);
  });
  it('caps at 10 s', () => {
    expect(parseRetryAfter('60', 0)).toBe(10_000);
    expect(parseRetryAfter('Wed, 21 Oct 2026 09:28:00 GMT', Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'))).toBe(10_000);
  });
  it('gives undefined for absent or unreadable values', () => {
    expect(parseRetryAfter(null, 0)).toBeUndefined();
    expect(parseRetryAfter('', 0)).toBeUndefined();
    expect(parseRetryAfter('soon', 0)).toBeUndefined();
  });
});

describe('archive hosts and constants', () => {
  it('recognises the archive and its subdomains only', () => {
    expect(isArchiveHost('web.archive.org')).toBe(true);
    expect(isArchiveHost('archive.org')).toBe(true);
    expect(isArchiveHost('Web.Archive.Org.')).toBe(true);
    expect(isArchiveHost('ia800.us.archive.org')).toBe(true);
    expect(isArchiveHost('notarchive.org')).toBe(false);
    expect(isArchiveHost('archive.org.evil.example')).toBe(false);
  });

  it('has 1000 ms for Node and 300 ms for the Worker', () => {
    expect(ARCHIVE_MIN_GAP_MS).toEqual({ node: 1000, worker: 300 });
  });

  it('the default queue is shared until reset', () => {
    resetDefaultArchiveQueue();
    const a = defaultArchiveQueue();
    expect(defaultArchiveQueue()).toBe(a);
    expect(a.minGapMs).toBe(1000);
    resetDefaultArchiveQueue();
    expect(defaultArchiveQueue()).not.toBe(a);
    resetDefaultArchiveQueue();
  });
});
