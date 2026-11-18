import { describe, it, expect } from 'vitest';
import { classify } from '../src/core/classify.ts';
import type { Probe } from '../src/core/types.ts';

// Unit tests for classify() — one test per decision-table row.
// Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9

const ORIGINAL_URL = 'https://example.com/page';
const SAME_DOMAIN_URL = 'https://example.com/other';
const CROSS_DOMAIN_URL = 'https://other-site.com/page';

// A snapshot body whose 3-word shingles are entirely different from liveText,
// so similarity < 0.2 (triggers the possessed verdict).
const snapshotText =
  'The ancient ruins of a forgotten civilisation lie buried beneath the desert sand. ' +
  'Archaeologists have spent decades excavating this remarkable site near the valley. ' +
  'Each artefact recovered tells a story about how people lived centuries before us. ' +
  'The pottery fragments and stone tools give insight into their daily routines and customs.';

// Live text that shares no shingles with snapshotText.
const lowSimilarityLiveText =
  'Buy laptops, smartphones, tablets and accessories at unbeatable prices today. ' +
  'Free delivery on orders over fifty dollars with our premium membership programme. ' +
  'Shop thousands of deals updated every hour from your favourite brands and retailers. ' +
  'Sign up for exclusive vouchers and discount codes sent directly to your inbox weekly.';

// Live text that is nearly identical to snapshotText (similarity ≥ 0.2).
const highSimilarityLiveText =
  'The ancient ruins of a forgotten civilisation lie buried beneath the desert sand. ' +
  'Archaeologists have spent decades excavating this remarkable site near the valley. ' +
  'Each artefact recovered tells a story about how people lived centuries before us. ' +
  'New pottery fragments and stone tools continue to give insight into their customs.';

describe('classify — decision table', () => {
  // Row 1: timeout → restless
  it('timeout returns restless', () => {
    const probe: Probe = { outcome: 'timeout' };
    const result = classify(probe, ORIGINAL_URL);
    expect(result.verdict).toBe('restless');
    expect(result.reason).toContain('timed out');
  });

  // Row 2: network-error (DNS failure) → dead
  it('DNS failure (network-error ENOTFOUND) returns dead', () => {
    const probe: Probe = { outcome: 'network-error', text: 'ENOTFOUND example.com' };
    const result = classify(probe, ORIGINAL_URL);
    expect(result.verdict).toBe('dead');
    expect(result.reason).toContain('ENOTFOUND');
  });

  // Row 3a: 401 → restless
  it('401 returns restless', () => {
    const probe: Probe = { outcome: 'response', status: 401, finalUrl: ORIGINAL_URL };
    const result = classify(probe, ORIGINAL_URL);
    expect(result.verdict).toBe('restless');
    expect(result.reason).toContain('401');
  });

  // Row 3b: 403 → restless
  it('403 returns restless', () => {
    const probe: Probe = { outcome: 'response', status: 403, finalUrl: ORIGINAL_URL };
    const result = classify(probe, ORIGINAL_URL);
    expect(result.verdict).toBe('restless');
    expect(result.reason).toContain('403');
  });

  // Row 3c: 429 → restless
  it('429 returns restless', () => {
    const probe: Probe = { outcome: 'response', status: 429, finalUrl: ORIGINAL_URL };
    const result = classify(probe, ORIGINAL_URL);
    expect(result.verdict).toBe('restless');
    expect(result.reason).toContain('429');
  });

  // Row 4a: 404 → dead
  it('404 returns dead', () => {
    const probe: Probe = { outcome: 'response', status: 404, finalUrl: ORIGINAL_URL };
    const result = classify(probe, ORIGINAL_URL);
    expect(result.verdict).toBe('dead');
    expect(result.reason).toContain('404');
  });

  // Row 4b: 410 → dead
  it('410 returns dead', () => {
    const probe: Probe = { outcome: 'response', status: 410, finalUrl: ORIGINAL_URL };
    const result = classify(probe, ORIGINAL_URL);
    expect(result.verdict).toBe('dead');
    expect(result.reason).toContain('410');
  });

  // Row 5: 5xx after retry → restless with "after retry" in reason
  it('503 (5xx after retry) returns restless with "after retry" in reason', () => {
    const probe: Probe = { outcome: 'response', status: 503, finalUrl: ORIGINAL_URL };
    const result = classify(probe, ORIGINAL_URL);
    expect(result.verdict).toBe('restless');
    expect(result.reason).toContain('after retry');
    expect(result.reason).toContain('503');
  });

  // Row 8: 2xx same domain → alive
  it('200 same domain returns alive', () => {
    const probe: Probe = { outcome: 'response', status: 200, finalUrl: SAME_DOMAIN_URL };
    const result = classify(probe, ORIGINAL_URL);
    expect(result.verdict).toBe('alive');
  });

  // Row 6: 2xx cross-domain with snapshotText and low similarity → possessed
  it('200 cross-domain with low similarity to snapshot returns possessed', () => {
    const probe: Probe = {
      outcome: 'response',
      status: 200,
      finalUrl: CROSS_DOMAIN_URL,
      text: lowSimilarityLiveText,
    };
    const result = classify(probe, ORIGINAL_URL, snapshotText);
    expect(result.verdict).toBe('possessed');
    expect(result.reason).toContain('similar');
  });

  // Row 7: 2xx cross-domain with no snapshot → alive with "redirected to" in reason
  it('200 cross-domain with no snapshot returns alive mentioning new domain', () => {
    const probe: Probe = {
      outcome: 'response',
      status: 200,
      finalUrl: CROSS_DOMAIN_URL,
    };
    const result = classify(probe, ORIGINAL_URL);
    expect(result.verdict).toBe('alive');
    expect(result.reason).toContain('redirected to');
    expect(result.reason).toContain('other-site.com');
  });

  // Row 6 (high similarity branch): 2xx cross-domain high similarity → alive
  it('200 cross-domain with high similarity to snapshot returns alive', () => {
    const probe: Probe = {
      outcome: 'response',
      status: 200,
      finalUrl: CROSS_DOMAIN_URL,
      text: highSimilarityLiveText,
    };
    const result = classify(probe, ORIGINAL_URL, snapshotText);
    expect(result.verdict).toBe('alive');
  });
});
