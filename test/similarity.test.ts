import { describe, it, expect } from 'vitest';
import { similarity } from '#core';

// ---------------------------------------------------------------------------
// Calibration data from docs/brief/calibration.md (measured 16 Nov 2026)
//   paulgraham.com/hp.html  — similarity vs last capture ≈ 1.00 (stable essay)
//   kiko.com                — similarity ≈ 0.00 (redirected to bestshop.com)
//   news.ycombinator.com    — similarity vs last capture ≈ 0.13 (hourly churn)
//
// Tests below use representative text to exercise the same shingle behaviour.
// Validates: Requirement 2.5
// ---------------------------------------------------------------------------

// Representative excerpt from paulgraham.com/hp.html (a stable static essay).
// Two captures of the same text should score ~1.0.
const pgEssay =
  'If you want to make a lot of money, one way is to get a lot of users. ' +
  'The more users you have, the more money you can make from ads or subscriptions. ' +
  'But there is another way: make something that a small number of people love. ' +
  'A startup that gets a thousand people to love it is in better shape than one ' +
  'that gets a million people to sort of like it. ' +
  'The way to get a thousand people to love you is to make something they want. ' +
  'That sounds obvious, but it has an important implication: you have to find out ' +
  'what people want. This is hard, because people often do not know what they want. ';

// Representative content of bestshop.com (a commercial replacement site).
// Nothing in common with the original kiko.com calendar app essay.
const bestshopContent =
  'Shop the best deals on electronics, home appliances, furniture and fashion. ' +
  'Free shipping on orders over fifty dollars. Browse our sale section for discounts ' +
  'on televisions, laptops, smartphones and tablets. Sign up for our newsletter to ' +
  'receive exclusive coupons and promotional offers every week. Best prices guaranteed. ' +
  'Customer service available twenty four hours a day seven days a week by phone or chat.';

// Two HN snapshots taken hours apart. Shares some persistent UI text
// ("Ask HN", "Show HN", item counts) but most story titles differ.
const hnCapture1 =
  'Hacker News new comments ask show jobs submit login ' +
  'Ask HN: How do you manage your dotfiles ' +
  'Show HN: I built a tool that checks dead links in any document ' +
  'YC application deadline is next Friday ' +
  'The state of Rust in 2026 ' +
  'Ask HN: What books changed how you think about software ' +
  'Show HN: Revenant brings dead links back from the Internet Archive ' +
  'Open source maintainers need better tooling for link rot ' +
  'Why SQLite is everywhere now ' +
  'From CRUD to event sourcing in a weekend ' +
  '300 comments 7 hours ago submit';

const hnCapture2 =
  'Hacker News new comments ask show jobs submit login ' +
  'Ask HN: Best resources for learning compilers ' +
  'Show HN: Terminal emulator written entirely in TypeScript ' +
  'Cloudflare announces new free tier limits for Workers ' +
  'The return of static site generators ' +
  'Why I stopped using TypeScript generics ' +
  'Ask HN: How do you stay focused working from home ' +
  'Open source licensing is getting more complicated ' +
  'Understanding Bloom filters from first principles ' +
  'The surprising performance of modern JSON parsers ' +
  '215 comments 3 hours ago submit';

describe('similarity', () => {
  // -------------------------------------------------------------------------
  // Edge cases: empty inputs
  // -------------------------------------------------------------------------
  it('returns 0 for two empty strings', () => {
    expect(similarity('', '')).toBe(0);
  });

  it('returns 0 when the first string is empty', () => {
    expect(similarity('', 'some text with enough words here')).toBe(0);
  });

  it('returns 0 when the second string is empty', () => {
    expect(similarity('some text with enough words here', '')).toBe(0);
  });

  // Strings too short to form any 3-word shingle
  it('returns 0 when both strings have fewer than 3 words', () => {
    expect(similarity('hello world', 'hello world')).toBe(0);
  });

  it('returns 0 when one string has fewer than 3 words', () => {
    expect(similarity('hello world', 'the quick brown fox jumps over the lazy dog')).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Identical strings — must return exactly 1
  // -------------------------------------------------------------------------
  it('returns 1 for identical strings', () => {
    const text = 'the quick brown fox jumps over the lazy dog';
    expect(similarity(text, text)).toBe(1);
  });

  it('returns 1 for identical longer texts', () => {
    const text =
      'Links rot. Pew Research found that 38 percent of web pages from 2013 are gone ' +
      'and 54 percent of Wikipedia pages have at least one dead reference. ' +
      'Worse than a dead link is a possessed one: the URL still answers 200, ' +
      'but the domain was sold and now serves ads, spam or malware.';
    expect(similarity(text, text)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Calibration examples — Requirement 2.5
  // -------------------------------------------------------------------------

  // paulgraham.com/hp.html: stable essay, two captures are byte-for-byte equal → ~1.0
  it('calibration: stable essay (paul graham) scores ~1.0 against itself', () => {
    const score = similarity(pgEssay, pgEssay);
    expect(score).toBeCloseTo(1.0, 2); // within 0.005
  });

  it('calibration: near-identical captures of a stable essay score > 0.75', () => {
    // Simulate an editorial edit: one full sentence reworded.
    // Jaccard over 3-grams on short texts drops noticeably per changed sentence,
    // but the two versions still share the vast majority of shingles.
    const edited = pgEssay.replace(
      'The way to get a thousand people to love you is to make something they want.',
      'Getting a thousand people to love you means making something they actually need.',
    );
    expect(similarity(pgEssay, edited)).toBeGreaterThan(0.75);
  });

  // kiko.com: redirected to bestshop.com — completely different content → ~0.0
  it('calibration: possessed site (kiko → bestshop) scores ~0.0', () => {
    const score = similarity(pgEssay, bestshopContent);
    expect(score).toBeLessThan(0.05);
  });

  it('calibration: unrelated commercial replacement scores 0 (no shared shingles)', () => {
    // Both pages have enough words to form shingles, but share none.
    expect(similarity(pgEssay, bestshopContent)).toBe(0);
  });

  // news.ycombinator.com: hourly churn → ~0.13 (some shared chrome, mostly new stories)
  it('calibration: dynamic page like HN scores between 0.05 and 0.3', () => {
    const score = similarity(hnCapture1, hnCapture2);
    expect(score).toBeGreaterThan(0.05);
    expect(score).toBeLessThan(0.3);
  });

  // -------------------------------------------------------------------------
  // Fully disjoint content
  // -------------------------------------------------------------------------
  it('returns 0 for completely unrelated content', () => {
    const a =
      'the quick brown fox jumps over the lazy dog near the river bank on a sunny afternoon';
    const b =
      'quantum computing leverages superposition and entanglement to perform parallel calculations ' +
      'that classical processors cannot efficiently solve in polynomial time';
    expect(similarity(a, b)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Near-identical content (calibration: > 0.8)
  // -------------------------------------------------------------------------
  it('scores > 0.8 for near-identical texts (single word changed)', () => {
    const base =
      'Revenant finds the dead and possessed links in any document and brings them back ' +
      'from the Internet Archive. Links rot and 38 percent of web pages from 2013 are gone.';
    const variant = base.replace('possessed', 'corrupted');
    expect(similarity(base, variant)).toBeGreaterThan(0.8);
  });

  it('scores > 0.65 for near-identical texts (extra sentence appended)', () => {
    // Adding one new sentence to a short text introduces new shingles at the boundary.
    // With short base texts, Jaccard penalises additions more than on long texts,
    // but the score stays well above the 0.2 possessed threshold.
    const base =
      'Open-source maintainers, writers, researchers and journalists whose citations must stay ' +
      'verifiable need a tool that checks every link and brings dead ones back to life.';
    const extended = base + ' This is the core problem that Revenant solves every day.';
    expect(similarity(base, extended)).toBeGreaterThan(0.65);
  });

  // -------------------------------------------------------------------------
  // Symmetry
  // -------------------------------------------------------------------------
  it('is symmetric: similarity(a, b) === similarity(b, a)', () => {
    const a =
      'the quick brown fox jumps over the lazy dog near the river bank on a sunny afternoon';
    const b =
      'a lazy dog rests near the river bank while the quick brown fox leaps over fallen logs';
    expect(similarity(a, b)).toBe(similarity(b, a));
  });

  it('symmetry holds for empty vs non-empty', () => {
    const text = 'some text with more than three words total';
    expect(similarity('', text)).toBe(similarity(text, ''));
  });

  it('calibration examples are symmetric', () => {
    expect(similarity(hnCapture1, hnCapture2)).toBe(similarity(hnCapture2, hnCapture1));
  });

  // -------------------------------------------------------------------------
  // Range: result always in [0, 1]
  // -------------------------------------------------------------------------
  it('scores strictly between 0 and 1 for partially overlapping content', () => {
    const a =
      'the quick brown fox jumps over the lazy dog near the river bank on a sunny afternoon';
    const b =
      'a quick brown fox leaps over the lazy cat near the mountain stream on a rainy morning';
    const score = similarity(a, b);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('result is never negative', () => {
    expect(similarity(pgEssay, bestshopContent)).toBeGreaterThanOrEqual(0);
    expect(similarity('', '')).toBeGreaterThanOrEqual(0);
  });

  it('result never exceeds 1', () => {
    expect(similarity(pgEssay, pgEssay)).toBeLessThanOrEqual(1);
    expect(similarity(hnCapture1, hnCapture2)).toBeLessThanOrEqual(1);
  });
});
