import type { Capture, ChosenLife } from './types.js';

/** A gap of more than this many calendar months between consecutive captures starts a new life. */
const MAX_GAP_MONTHS = 12;

/** Calendar month index from the yyyymm part of a 14-digit timestamp. */
function monthIndex(timestamp: string): number {
  return Number(timestamp.slice(0, 4)) * 12 + Number(timestamp.slice(4, 6));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Pick the capture range that represents the longest continuous life of a URL.
 *
 * Captures are sorted by timestamp inside, so input order does not matter.
 * A new life starts wherever more than 12 calendar months separate two consecutive captures.
 * The longest life by span (months from first to last capture) wins; a tie goes to the earliest.
 * `first` is the life's first capture. `last` is the life's last capture whose length is at
 * least half the life's median known length; if none qualifies (or no length is known), the
 * life's last capture. Returns undefined for an empty input.
 */
export function chooseLife(captures: readonly Capture[]): ChosenLife | undefined {
  if (captures.length === 0) return undefined;
  const sorted = [...captures].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  );

  const lives: Capture[][] = [];
  let current: Capture[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const next = sorted[i]!;
    if (monthIndex(next.timestamp) - monthIndex(prev.timestamp) > MAX_GAP_MONTHS) {
      lives.push(current);
      current = [];
    }
    current.push(next);
  }
  lives.push(current);

  const span = (life: Capture[]): number =>
    monthIndex(life[life.length - 1]!.timestamp) - monthIndex(life[0]!.timestamp);

  let best = lives[0]!;
  for (const life of lives) {
    if (span(life) > span(best)) best = life; // strict: ties keep the earliest
  }

  const known = best.flatMap((c) => (c.length === undefined ? [] : [c.length]));
  let last = best[best.length - 1]!.timestamp;
  if (known.length > 0) {
    const threshold = median(known) / 2;
    for (let i = best.length - 1; i >= 0; i--) {
      const len = best[i]!.length;
      if (len !== undefined && len >= threshold) {
        last = best[i]!.timestamp;
        break;
      }
    }
  }

  return { first: best[0]!.timestamp, last };
}

