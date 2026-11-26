/**
 * extract(source, kind) — pure link extractor.
 *
 * Returns one Link per distinct URL found in `source`. Each Link carries
 * every byte span (start inclusive, end exclusive) in `source` at which
 * the URL string appears, so `source.slice(span.start, span.end) === url`.
 *
 * Requirements: 1.1, 1.2, 1.5, 1.6
 */

import type { Link } from './types.js';

// ---------------------------------------------------------------------------
// Fenced-block detection
// ---------------------------------------------------------------------------

/**
 * Returns a Set of byte offsets that fall inside a fenced code block.
 * Fences: ``` or ~~~, three or more characters, optionally followed by an
 * info string on the same line.
 */
function fencedOffsets(source: string): Set<number> {
  const blocked = new Set<number>();
  // Regex matches a fence open/close line. We scan line by line.
  const lines = splitLines(source);
  let pos = 0;
  let insideFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  for (const line of lines) {
    const lineEnd = pos + line.length;
    if (!insideFence) {
      const m = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
      if (m) {
        insideFence = true;
        fenceChar = m[1][0]!;
        fenceLen = m[1].length;
        // The fence-open line itself is inside the block (don't extract from it)
        for (let i = pos; i < lineEnd; i++) blocked.add(i);
      }
    } else {
      // Look for a matching closing fence (same char, >= same length, only spaces allowed after)
      const trimmedLine = line.replace(/[\r\n]+$/, '');
      const m = new RegExp(`^[ \\t]{0,3}(\\${fenceChar}{${fenceLen},})[ \\t]*$`).exec(trimmedLine);
      if (m) {
        for (let i = pos; i < lineEnd; i++) blocked.add(i);
        insideFence = false;
      } else {
        for (let i = pos; i < lineEnd; i++) blocked.add(i);
      }
    }
    pos = lineEnd;
  }
  return blocked;
}

/** Split a string into lines preserving line-ending characters. */
function splitLines(s: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n') {
      lines.push(s.slice(start, i + 1));
      start = i + 1;
    } else if (s[i] === '\r') {
      if (s[i + 1] === '\n') {
        lines.push(s.slice(start, i + 2));
        i++;
        start = i + 1;
      } else {
        lines.push(s.slice(start, i + 1));
        start = i + 1;
      }
    }
  }
  if (start < s.length) lines.push(s.slice(start));
  return lines;
}

// ---------------------------------------------------------------------------
// Scheme filter
// ---------------------------------------------------------------------------

function isHttpOrHttps(url: string): boolean {
  const m = /^https?:\/\/([^/?#]*)/.exec(url);
  if (!m) return false;
  // A URL without a host ("http://", "https:///x") is a scheme fragment, not a link.
  const host = m[1]!.slice(m[1]!.lastIndexOf('@') + 1).replace(/:\d*$/, '');
  return host !== '';
}

// ---------------------------------------------------------------------------
// Result accumulator
// ---------------------------------------------------------------------------

/** Accumulates spans per URL, preserving encounter order. */
class LinkMap {
  private order: string[] = [];
  private map = new Map<string, Array<{ start: number; end: number }>>();

  add(url: string, start: number, end: number): void {
    if (!this.map.has(url)) {
      this.order.push(url);
      this.map.set(url, []);
    }
    const spans = this.map.get(url)!;
    // The same position can be reached by two scanners (e.g. a reference
    // definition seen as a reference and as a bare URL); record it once.
    if (spans.some(s => s.start === start && s.end === end)) return;
    spans.push({ start, end });
  }

  toLinks(): Link[] {
    return this.order.map(url => ({
      url,
      spans: this.map.get(url)!,
    }));
  }
}

// ---------------------------------------------------------------------------
// Markdown extraction
// ---------------------------------------------------------------------------

/**
 * Collect reference link definitions: `[id]: url` anywhere in source.
 * Returns a Map from lowercased id → { url, start, end }.
 * `start`/`end` refer to the URL portion in `source`.
 */
function collectReferenceDefinitions(
  source: string,
  blocked: Set<number>,
): Map<string, { url: string; start: number; end: number }> {
  const defs = new Map<string, { url: string; start: number; end: number }>();
  // Pattern: start of line (optionally up to 3 spaces), [id]: url, optional title
  // We allow any amount of whitespace after the colon.
  // Destination is `<url with spaces or parens>` or a run of non-whitespace
  // (balanced parentheses are part of it, as `\S+` takes everything).
  const re = /^[ \t]{0,3}\[([^\]]+)\]:[ \t]+(?:<([^>\n]*)>|(\S+))/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const angle = m[2] !== undefined;
    const url = angle ? m[2]! : m[3]!;
    // Position of the destination itself (after `<` for the angle form).
    const urlStart = m.index + m[0].length - url.length - (angle ? 1 : 0);
    // Skip if the definition is inside a fenced block
    if (blocked.has(urlStart)) continue;
    if (!isHttpOrHttps(url)) continue;
    const id = m[1]!.toLowerCase();
    if (!defs.has(id)) {
      // Only the first definition wins (CommonMark spec)
      defs.set(id, { url, start: urlStart, end: urlStart + url.length });
    }
  }
  return defs;
}

export function extractMarkdown(source: string): Link[] {
  const blocked = fencedOffsets(source);
  const links = new LinkMap();

  // --- Pass 1: Reference definitions ---
  const defs = collectReferenceDefinitions(source, blocked);

  // --- Pass 2: Inline links [text](url) ---
  // We scan manually to handle nested brackets correctly.
  scanInlineLinks(source, blocked, links);

  // --- Pass 3: Autolinks <url> ---
  scanAutolinks(source, blocked, links);

  // --- Pass 4: Reference links [text][id] and [text][] ---
  scanReferenceLinks(source, blocked, defs, links);

  // --- Pass 5: Bare URLs ---
  scanBareUrls(source, blocked, links);

  return links.toLinks();
}

/** Scan for inline links: `[text](url)` or `[text](url "title")` */
function scanInlineLinks(source: string, blocked: Set<number>, links: LinkMap): void {
  // We need to find `](url)` patterns. The tricky part is matching the
  // opening bracket. We use a regex to find `](` and then scan backwards
  // for the matching `[`, then extract the URL inside `()`.
  //
  // Strategy: find each `](` occurrence, skip anything in blocked ranges.
  let from = 0;
  for (;;) {
    const at = source.indexOf('](', from);
    if (at === -1) break;
    from = at + 2;
    if (blocked.has(at + 1)) continue; // `(` is inside a fenced block

    const dest = parseDestination(source, at + 2);
    if (!dest || !isHttpOrHttps(dest.url)) continue;
    links.add(dest.url, dest.start, dest.end);
  }
}

/**
 * Parse an inline link destination starting right after `(`.
 * - `<...>` form: everything up to `>` (spaces and parentheses allowed, no newline).
 * - Plain form: ends at whitespace, at `>`, or at the first `)` that would take
 *   the parenthesis depth below zero (CommonMark balanced parentheses).
 * An optional title after whitespace is left alone. Returns null when the
 * destination is not followed by `)` or whitespace.
 */
function parseDestination(
  source: string,
  from: number,
): { url: string; start: number; end: number } | null {
  let i = from;
  while (i < source.length && /\s/.test(source[i]!)) i++;
  if (i >= source.length) return null;

  if (source[i] === '<') {
    const start = i + 1;
    let k = start;
    while (k < source.length && source[k] !== '>' && source[k] !== '<' && source[k] !== '\n') k++;
    if (source[k] !== '>' || k === start) return null;
    return { url: source.slice(start, k), start, end: k };
  }

  const start = i;
  let depth = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === '\\' && (source[i + 1] === '(' || source[i + 1] === ')')) {
      i += 2;
      continue;
    }
    if (/\s/.test(c) || c === '>') break;
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) break;
      depth--;
    }
    i++;
  }
  if (i === start) return null;
  const next = source[i];
  if (next !== ')' && (next === undefined || !/\s/.test(next))) return null;
  return { url: source.slice(start, i), start, end: i };
}

/** Scan for autolinks: `<url>` where url starts with http:// or https:// */
function scanAutolinks(source: string, blocked: Set<number>, links: LinkMap): void {
  const re = /<(https?:\/\/[^>\s]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const urlStart = m.index + 1; // skip `<`
    const urlEnd = urlStart + m[1]!.length;
    if (blocked.has(urlStart)) continue;
    const url = m[1]!;
    if (!isHttpOrHttps(url)) continue;
    links.add(url, urlStart, urlEnd);
  }
}

/** Scan for reference links: `[text][id]`, `[text][]`, `[id]` (collapsed/shortcut) */
function scanReferenceLinks(
  source: string,
  blocked: Set<number>,
  defs: Map<string, { url: string; start: number; end: number }>,
  links: LinkMap,
): void {
  // The span for a reference link goes to the definition line URL, not to
  // the `[text][id]` usage. The design says "span covers the URL in the
  // definition line", so we add the definition span, not the usage span.
  //
  // We want to find usages to know *which* definitions are referenced, then
  // record the definition's URL span.
  //
  // However, we must not double-count a definition URL if it was already
  // added as a bare URL or inline link. The LinkMap deduplicates by URL,
  // so adding the same (url, start, end) twice would create two spans for
  // the same position. We track definition spans already added.
  const addedDefSpans = new Set<string>(); // "start:end"

  // Match [text][id], [text][], and shortcut [id]
  // We'll scan for `][` patterns for full references, and `][` with empty
  // for collapsed, and standalone `[...]` for shortcuts.

  // Full: [text][id]
  const reFull = /\[([^\]]*)\]\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = reFull.exec(source)) !== null) {
    if (blocked.has(m.index)) continue;
    const rawId = m[2]!;
    const id = (rawId === '' ? m[1]! : rawId).toLowerCase();
    const def = defs.get(id);
    if (!def) continue;
    const key = `${def.start}:${def.end}`;
    if (addedDefSpans.has(key)) continue;
    addedDefSpans.add(key);
    links.add(def.url, def.start, def.end);
  }

  // Shortcut: [text] where text matches a definition id (no second bracket pair)
  // We only add shortcut matches for ids that weren't already matched as full refs.
  // Pattern: `[text]` NOT followed by `[` or `(`
  const reShortcut = /\[([^\]]+)\](?!\[|\()/g;
  while ((m = reShortcut.exec(source)) !== null) {
    if (blocked.has(m.index)) continue;
    const id = m[1]!.toLowerCase();
    const def = defs.get(id);
    if (!def) continue;
    const key = `${def.start}:${def.end}`;
    if (addedDefSpans.has(key)) continue;
    addedDefSpans.add(key);
    links.add(def.url, def.start, def.end);
  }
}

/**
 * Scan for bare URLs: tokens starting with http:// or https:// that are
 * not enclosed in `<>` or `[]()`.
 */
function scanBareUrls(source: string, blocked: Set<number>, links: LinkMap): void {
  // We scan for `http://` or `https://` and greedily extend to the first
  // whitespace or one of the delimiters that "enclose" the URL.
  //
  // Characters that terminate a bare URL (Markdown-aware):
  //   whitespace, ), ], >, ", ', `, ,, ;  — plus end of string
  //   We also stop at `)` only when unbalanced.
  //
  // To avoid matching URLs inside `[text](url)` or `<url>`, we track
  // whether the match position is immediately preceded by `(` or `<`.

  // Parentheses are allowed in the match; unbalanced trailing `)` are trimmed below.
  const re = /https?:\/\/[^\s<>\]"'`,;]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const start = m.index;
    if (blocked.has(start)) continue;

    // Skip if immediately preceded by `(` → it's inside an inline link
    // (we already captured it in scanInlineLinks)
    if (start > 0 && source[start - 1] === '(') continue;

    // Skip if immediately preceded by `<` → it's an autolink
    if (start > 0 && source[start - 1] === '<') continue;

    let url = m[0]!;

    // Trim trailing punctuation that is likely sentence punctuation, not
    // part of the URL: trailing `.`, `,`, `;`, `:`, `!`, `?`, `)`, `]`
    // only when at the very end of the match.
    url = trimTrailingPunctuation(url);

    if (!url || !isHttpOrHttps(url)) continue;

    const end = start + url.length;
    links.add(url, start, end);
  }
}

/** Remove trailing sentence punctuation from a URL token. */
function trimTrailingPunctuation(url: string): string {
  for (;;) {
    const last = url[url.length - 1];
    if (last === '.' || last === ',' || last === ';' || last === ':' ||
        last === '!' || last === '?') {
      url = url.slice(0, -1);
    } else if (last === ')' && count(url, ')') > count(url, '(')) {
      // GFM rule: strip a trailing `)` only while the URL has more `)` than `(`.
      url = url.slice(0, -1);
    } else {
      break;
    }
  }
  return url;
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

// ---------------------------------------------------------------------------
// HTML extraction
// ---------------------------------------------------------------------------

/**
 * Extract href values from `<a ...>` elements using a hand-written scanner.
 * No DOM dependency; pure string processing.
 */
export function extractHtml(source: string): Link[] {
  const links = new LinkMap();
  // Two-step approach:
  // 1. Find each <a tag start
  // 2. Within the tag, find href="..." or href='...' or href=...
  const aTagRe = /<a(?:\s|>)/gi;
  let aMatch: RegExpExecArray | null;  // eslint-disable-line prefer-const
  while ((aMatch = aTagRe.exec(source)) !== null) {
    // Find end of tag (closing `>` not inside quotes)
    const tagStart = aMatch.index;
    const tagEnd = findTagEnd(source, tagStart);
    if (tagEnd === -1) continue;

    const tagContent = source.slice(tagStart, tagEnd + 1);
    const hrefResult = extractHrefFromTag(tagContent);
    if (!hrefResult) continue;

    const { url, rawLength, offsetInTag } = hrefResult;
    if (!isHttpOrHttps(url)) continue;

    const urlStart = tagStart + offsetInTag;
    // Use rawLength (pre-decode byte count) so the span covers exactly the
    // raw source bytes; after entity decoding url.length may differ.
    const urlEnd = urlStart + rawLength;

    links.add(url, urlStart, urlEnd);
  }

  return links.toLinks();
}

/** Find the closing `>` of a tag starting at `start`, respecting quotes. */
function findTagEnd(source: string, start: number): number {
  let inQuote: string | null = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i]!;
    if (inQuote) {
      if (c === inQuote) inQuote = null;
    } else {
      if (c === '"' || c === "'") inQuote = c;
      else if (c === '>') return i;
    }
  }
  return -1;
}

/**
 * Extract the href value from a tag string (e.g. `<a href="url">`).
 * Returns `{ url, rawLength, offsetInTag }` where:
 *   - `url` is the decoded URL (HTML entities resolved),
 *   - `rawLength` is the byte length of the raw (un-decoded) href value in source,
 *   - `offsetInTag` is the byte offset of the href value start within `tagContent`.
 * The span in source is [offsetInTag, offsetInTag + rawLength).
 */
function extractHrefFromTag(
  tagContent: string,
): { url: string; rawLength: number; offsetInTag: number } | null {
  // Match href="...", href='...', or href=... (unquoted, up to whitespace or >)
  const re = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/i;
  const m = re.exec(tagContent);
  if (!m) return null;

  const quoted1 = m[1]; // double-quoted
  const quoted2 = m[2]; // single-quoted
  const unquoted = m[3]; // unquoted

  let url: string;
  let quoteOffset: number;

  if (quoted1 !== undefined) {
    url = quoted1;
    // Find the opening `"` after `href=` and the url follows it
    const hrefIdx = m.index;
    const eqIdx = tagContent.indexOf('=', hrefIdx + 4); // skip 'href'
    // Find opening quote
    let qi = eqIdx + 1;
    while (qi < tagContent.length && (tagContent[qi] === ' ' || tagContent[qi] === '\t')) qi++;
    quoteOffset = qi + 1; // skip the opening quote
  } else if (quoted2 !== undefined) {
    url = quoted2;
    const hrefIdx = m.index;
    const eqIdx = tagContent.indexOf('=', hrefIdx + 4);
    let qi = eqIdx + 1;
    while (qi < tagContent.length && (tagContent[qi] === ' ' || tagContent[qi] === '\t')) qi++;
    quoteOffset = qi + 1;
  } else if (unquoted !== undefined && unquoted !== '') {
    url = unquoted;
    const hrefIdx = m.index;
    const eqIdx = tagContent.indexOf('=', hrefIdx + 4);
    let qi = eqIdx + 1;
    while (qi < tagContent.length && (tagContent[qi] === ' ' || tagContent[qi] === '\t')) qi++;
    quoteOffset = qi;
  } else {
    return null;
  }

  if (!url) return null;

  // Capture raw length before entity decoding — needed for span computation.
  // After decoding, url.length may differ (e.g. '&amp;' → '&' shrinks by 4).
  const rawLength = url.length;

  // Decode HTML entities in the URL — the most common ones
  url = decodeHtmlEntities(url);

  return { url, rawLength, offsetInTag: quoteOffset };
}

/** Decode the most common HTML entities that may appear in href values. */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function extract(source: string, kind: 'markdown' | 'html'): Link[] {
  if (kind === 'markdown') return extractMarkdown(source);
  return extractHtml(source);
}
