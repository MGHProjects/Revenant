/**
 * result-headline.ts: the sentence the hero shows when a scan ends. Pure: no DOM, no globals.
 * `dead`, `possessed` and `restless` count judged links only; `fixable` is the number of dead or
 * possessed links that have an archived copy; `failed` is the number of links with no judgement.
 */

export interface HeadlineCounts {
  total: number;
  dead: number;
  possessed: number;
  fixable: number;
  restless: number;
  failed: number;
}

const links = (n: number): string => (n === 1 ? 'link' : 'links');

/** The verdict sentences for `total` links, of which `gone` are dead or possessed. */
function verdictSentence(total: number, c: HeadlineCounts): string {
  const gone = c.dead + c.possessed;
  const parts: string[] = [];
  if (gone > 0) {
    parts.push(`${gone} of ${total} ${links(total)} ${gone === 1 ? 'is' : 'are'} gone.`);
    parts.push(c.fixable > 0 ? `${c.fixable} can come back.` : 'None can come back.');
  } else if (c.restless === 0) {
    parts.push(total === 1 ? 'All 1 link still leads where it should.' : `All ${total} links still lead where they should.`);
  } else {
    // Some links could not be judged: never say "All". With nothing alive, "0 links still lead..." is
    // true but odd, so the sentence is "None could be judged." instead.
    const alive = total - c.restless;
    if (alive === 0) return 'None could be judged.';
    parts.push(alive === 1 ? '1 link still leads where it should.' : `${alive} links still lead where they should.`);
  }
  if (c.restless > 0) parts.push(`${c.restless} could not be judged.`);
  return parts.join(' ');
}

export function resultHeadline(c: HeadlineCounts): string {
  const judged = c.total - c.failed;
  if (c.failed > 0) {
    const lead = `${judged} of ${c.total} ${links(c.total)} judged.`;
    return judged > 0 ? `${lead} ${verdictSentence(judged, c)}` : lead;
  }
  return verdictSentence(c.total, c);
}
