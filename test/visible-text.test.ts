import { describe, it, expect } from 'vitest';
import { visibleText } from '../src/core/visible-text.js';

describe('visibleText', () => {
  // --- basic tag stripping ---

  it('returns plain text unchanged', () => {
    expect(visibleText('hello world')).toBe('hello world');
  });

  it('strips a simple HTML tag', () => {
    expect(visibleText('<p>hello</p>')).toBe('hello');
  });

  it('strips multiple tags', () => {
    expect(visibleText('<h1>Title</h1><p>Body</p>')).toBe('Title Body');
  });

  it('inserts a space at tag boundaries so adjacent words do not merge', () => {
    const result = visibleText('<p>foo</p><p>bar</p>');
    // "foo" and "bar" should be separated by at least one space
    expect(result).toMatch(/foo\s+bar/);
  });

  // --- <script> block removal ---

  it('removes an inline <script> block entirely', () => {
    const html = '<p>before</p><script>var x = 1;</script><p>after</p>';
    expect(visibleText(html)).toBe('before after');
  });

  it('removes a <script> block with attributes', () => {
    const html = '<p>a</p><script type="text/javascript">alert(1)</script><p>b</p>';
    expect(visibleText(html)).toBe('a b');
  });

  it('removes multiline <script> content', () => {
    const html = '<p>start</p>\n<script>\nfunction f() {\n  return 1;\n}\n</script>\n<p>end</p>';
    const result = visibleText(html);
    expect(result).not.toContain('function');
    expect(result).toContain('start');
    expect(result).toContain('end');
  });

  it('handles a document with no closing </script>', () => {
    // Open <script> with no close — everything after is dropped; no crash
    const html = '<p>before</p><script>orphan';
    const result = visibleText(html);
    expect(result).toBe('before');
    expect(result).not.toContain('orphan');
  });

  // --- <style> block removal ---

  it('removes an inline <style> block entirely', () => {
    const html = '<p>text</p><style>body { color: red; }</style><p>more</p>';
    expect(visibleText(html)).toBe('text more');
  });

  it('removes a multiline <style> block', () => {
    const html = '<style>\n.foo {\n  display: none;\n}\n</style><p>visible</p>';
    const result = visibleText(html);
    expect(result).not.toContain('.foo');
    expect(result).toContain('visible');
  });

  // --- case insensitivity ---

  it('removes <SCRIPT> in upper case', () => {
    const html = '<p>a</p><SCRIPT>evil()</SCRIPT><p>b</p>';
    expect(visibleText(html)).toBe('a b');
  });

  it('removes <Style> in mixed case', () => {
    const html = '<p>a</p><Style>h1{}</Style><p>b</p>';
    expect(visibleText(html)).toBe('a b');
  });

  // --- HTML entity decoding ---

  it('decodes &amp;', () => {
    expect(visibleText('a &amp; b')).toBe('a & b');
  });

  it('decodes &lt; and &gt;', () => {
    expect(visibleText('1 &lt; 2 &gt; 0')).toBe('1 < 2 > 0');
  });

  it('decodes &quot; and &apos;', () => {
    expect(visibleText('say &quot;hi&quot; &apos;there&apos;')).toBe("say \"hi\" 'there'");
  });

  it('decodes &nbsp; as a space', () => {
    expect(visibleText('a&nbsp;b')).toBe('a b');
  });

  it('decodes decimal numeric entities', () => {
    // &#65; = 'A', &#66; = 'B'
    expect(visibleText('&#65;&#66;')).toBe('AB');
  });

  it('decodes hex numeric entities', () => {
    // &#x41; = 'A'
    expect(visibleText('&#x41;')).toBe('A');
  });

  // --- whitespace normalisation ---

  it('collapses multiple spaces', () => {
    expect(visibleText('a   b')).toBe('a b');
  });

  it('collapses newlines and tabs', () => {
    expect(visibleText('a\n\t b')).toBe('a b');
  });

  it('trims leading and trailing whitespace', () => {
    expect(visibleText('  hello  ')).toBe('hello');
  });

  // --- empty input ---

  it('returns empty string for empty input', () => {
    expect(visibleText('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(visibleText('   \n\t  ')).toBe('');
  });

  it('returns empty string for tags-only input', () => {
    expect(visibleText('<html><head></head><body></body></html>')).toBe('');
  });

  // --- realistic HTML snippet ---

  it('extracts visible text from a realistic page snippet', () => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>Test Page</title>
  <style>body { font-size: 16px; }</style>
</head>
<body>
  <h1>Hello, world!</h1>
  <p>This is a <a href="https://example.com">link</a> in a paragraph.</p>
  <script>console.log('hidden');</script>
  <p>Second paragraph.</p>
</body>
</html>`;
    const result = visibleText(html);
    expect(result).toContain('Hello, world!');
    expect(result).toContain('This is a');
    expect(result).toContain('link');
    expect(result).toContain('in a paragraph');
    expect(result).toContain('Second paragraph');
    expect(result).not.toContain('font-size');
    expect(result).not.toContain("console.log");
    expect(result).not.toContain('hidden');
  });
});
