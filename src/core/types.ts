/** The four possible verdicts for a scanned link. */
export type Verdict = 'alive' | 'dead' | 'possessed' | 'restless';

/** A distinct URL found in a source document, with every byte span where it appears. */
export interface Link {
  url: string;
  spans: Array<{ start: number; end: number }>;
}

/**
 * What the network layer observed for a single URL fetch.
 * Passed to `classify()` to determine the verdict.
 */
export interface Probe {
  outcome: 'response' | 'network-error' | 'timeout';
  status?: number;
  finalUrl?: string;
  text?: string;
}

/** First and last Wayback Machine capture dates as ISO date strings (YYYY-MM-DD). */
export interface Epitaph {
  first: string;
  last: string;
}

/** The final assessment of one link after fetching and classification. */
export interface Judgement {
  link: Link;
  verdict: Verdict;
  reason: string;
  epitaph?: Epitaph | 'unavailable';
  resurrection?: string;
}

/**
 * Injectable network function. The core never imports a concrete implementation.
 * All doors (Worker, CLI, MCP) inject the real fetcher; tests inject a fake.
 */
export type Fetcher = (
  url: string,
  init?: { timeoutMs: number; maxBytes: number }
) => Promise<Probe>;

/**
 * Injectable Wayback Machine client.
 * Injected into `scan()` so tests can fake it without real network calls.
 */
export interface Wayback {
  getEpitaph(url: string): Promise<Epitaph | 'unavailable'>;
  getResurrection(url: string): Promise<string | undefined>;
  getSnapshotText(url: string): Promise<string | undefined>;
  /**
   * Snapshot closest to `date` (YYYY-MM-DD), or the most recent when omitted.
   * Distinguishes "no snapshot" from "archive unreachable". Optional so existing fakes still type-check.
   */
  getClosestSnapshot?(url: string, date?: string): Promise<ClosestSnapshot>;
}

export type ClosestSnapshot =
  | { status: 'found'; url: string; date: string }
  | { status: 'none' }
  | { status: 'unreachable' };

/** Events yielded by the `scan()` async generator. */
export type ScanEvent =
  | { type: 'meta'; total: number; capped: boolean; capLimit: 200 }
  | { type: 'judgement'; judgement: Judgement }
  | { type: 'error'; message: string };

/** Structured JSON output for the CLI `--json` flag. */
export interface CliOutput {
  links: Array<{
    url: string;
    verdict: Verdict;
    reason: string;
    resurrection?: string;
    epitaph?: Epitaph | 'unavailable';
    spans: Array<{ start: number; end: number }>;
  }>;
}
