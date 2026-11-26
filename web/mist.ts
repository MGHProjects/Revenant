/**
 * mist.ts: how thick the mist over the graveyard is.
 * Mist is what has not been judged: links still waiting plus links left restless, as a share of
 * all links. It is 1 before a scan (total 0) and falls as links are judged.
 */

/** Opacity in [0, 1], rounded to 2 decimals. waiting = total - judged. */
export function mistOpacity(total: number, judged: number, restless: number): number {
  if (!(total > 0)) return 1;
  const waiting = Math.max(0, total - Math.max(0, judged));
  const share = (waiting + Math.max(0, restless)) / total;
  return Math.round(Math.min(1, Math.max(0, share)) * 100) / 100;
}
