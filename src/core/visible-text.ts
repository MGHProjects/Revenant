/**
 * visibleText(html) — extracts visible text from an HTML string.
 *
 * Pure function: no DOM, no fetch, no globals.
 *
 * Rules applied in document order:
 *   1. Entire <script>…</script> blocks (including tags) are removed.
 *   2. Entire <style>…</style> blocks (including tags) are removed.
 *   3. All remaining HTML tags are stripped.
 *   4. HTML entities &amp; &lt; &gt; &quot; &apos; &#NNN; &#xHHH; are decoded.
 *   5. Runs of whitespace are collapsed to a single space; result is trimmed.
 */
export function visibleText(html: string): string {
  // --- 1 & 2: strip block-level tags and their content ---
  // We handle both <script> and <style> with a simple linear scan so we don't
  // need to worry about regex backtracking on large inputs.
  let s = stripBlockElement(html, 'script');
  s = stripBlockElement(s, 'style');

  // --- 3: strip all remaining tags ---
  s = stripTags(s);

  // --- 4: decode common HTML entities ---
  s = decodeEntities(s);

  // --- 5: normalise whitespace ---
  return s.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Remove every occurrence of <tagName …>…</tagName> from `html`, including the
 * tags themselves and everything between them.  Case-insensitive; handles
 * nested occurrences by iterating until no more matches remain (simple
 * elements like <script> and <style> are never nested, but we iterate anyway
 * for robustness).
 *
 * This is a linear scan: we look for the opening tag, then scan forward for
 * the closing tag. We do NOT parse attributes to find the opening tag end —
 * we just find the first `>` after the tag name, which is safe for
 * <script> and <style> because those tags carry no child elements.
 */
function stripBlockElement(html: string, tagName: string): string {
  const openTag = `<${tagName}`;
  const closeTag = `</${tagName}>`;
  const openLower = openTag.toLowerCase();
  const closeLower = closeTag.toLowerCase();

  let result = '';
  let pos = 0;
  const lower = html.toLowerCase();

  while (pos < html.length) {
    const openIdx = lower.indexOf(openLower, pos);
    if (openIdx === -1) {
      // No more opening tags — append the rest verbatim.
      result += html.slice(pos);
      break;
    }

    // Append everything before this opening tag.
    result += html.slice(pos, openIdx);

    // Find the end of the closing tag.
    const closeIdx = lower.indexOf(closeLower, openIdx);
    if (closeIdx === -1) {
      // No closing tag found — drop the rest of the string (open block).
      break;
    }

    // Advance past the closing tag.
    pos = closeIdx + closeTag.length;
  }

  return result;
}

/**
 * Strip all HTML tags (< … >) from a string, leaving only text content.
 * We use a simple character-by-character scan to avoid regex complexity on
 * strings with angle brackets in attribute values.
 */
function stripTags(html: string): string {
  let result = '';
  let inTag = false;

  for (let i = 0; i < html.length; i++) {
    const ch = html[i];
    if (ch === '<') {
      inTag = true;
    } else if (ch === '>') {
      inTag = false;
      // Replace block-level tags with a space to separate words that were
      // only separated by a tag boundary (e.g. <p>, <br>, <div>).
      result += ' ';
    } else if (!inTag) {
      result += ch;
    }
  }

  return result;
}

/**
 * Decode a small but complete set of HTML entities:
 *   - Named: &amp; &lt; &gt; &quot; &apos; &nbsp;
 *   - Decimal numeric: &#NNN;
 *   - Hex numeric: &#xHHH;
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/gi, (_, dec) =>
      String.fromCodePoint(parseInt(dec, 10)),
    );
}
