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
  /** Set only when a DNS-over-HTTPS lookup confirmed NXDOMAIN for the host. */
  dnsFailure?: true;
  /** Set when the fetcher already spent its full DNS budget on a 530; the caller must not retry. */
  noRetry?: true;
  /** Set when `guard` rejected the initial URL or a redirect hop. `text` holds the reason. */
  blocked?: true;
  /** Content-Type header of a `response` outcome, when present. */
  contentType?: string;
}

/** One Wayback capture: 14-digit timestamp and body length in bytes (undefined when unknown). */
export interface Capture {
  timestamp: string;
  length: number | undefined;
}

/** First and last 14-digit timestamps of the longest continuous life of a URL. */
export interface ChosenLife {
  first: string;
  last: string;
}

/** First and last Wayback Machine capture dates as ISO date strings (YYYY-MM-DD). */
export interface Epitaph {
  first: string;
  last: string;
}

/**
 * What the archive said about a URL.
 * - Epitaph: at least one 200 capture exists; first and last dates.
 * - 'none': the archive answered and holds no 200 capture (never archived).
 * - 'unavailable': the archive could not be reached (connection error, HTTP error, bad reply, timeout, second 429).
 */
export type EpitaphResult = Epitaph | 'none' | 'unavailable';

/** The final assessment of one link after fetching and classification. */
export interface Judgement {
  link: Link;
  verdict: Verdict;
  reason: string;
  epitaph?: EpitaphResult;
  resurrection?: string;
}

/**
 * Injectable network function. The core never imports a concrete implementation.
 * All doors (Worker, CLI, MCP) inject the real fetcher; tests inject a fake.
 */
export type Fetcher = (
  url: string,
  init?: { timeoutMs: number; maxBytes: number; skipDns?: boolean }
) => Promise<Probe>;

/** What one CDX request said about a URL. */
export interface ArchiveAnswer {
  epitaph: EpitaphResult;
  resurrection?: string;
}

/**
 * Injectable Wayback Machine client.
 * Injected into `scan()` so tests can fake it without real network calls.
 */
export interface Wayback {
  /**
   * One CDX answer yields both the epitaph and the resurrection, or neither.
   * `resurrection` is present only when `epitaph` holds dates ('none' and 'unavailable' have none).
   */
  getArchive(url: string): Promise<ArchiveAnswer>;
  /**
   * Visible text of the last good capture. Pass the `archive` answer already fetched in this
   * judgement so the CDX is not requested a second time.
   */
  getSnapshotText(url: string, archive?: ArchiveAnswer): Promise<SnapshotResult>;
  /**
   * Snapshot closest to `date` (YYYY-MM-DD), or the most recent when omitted.
   * Distinguishes "no snapshot" from "archive unreachable". Optional so existing fakes still type-check.
   */
  getClosestSnapshot?(url: string, date?: string): Promise<ClosestSnapshot>;
}

/**
 * What the archive said about the body of the last good capture of a URL.
 * Same semantics as `EpitaphResult`:
 * - 'text': the capture was fetched; `text` is its visible text.
 * - 'none': the archive answered and holds no usable 200 capture (empty CDX, or an empty body).
 * - 'unavailable': the archive could not be reached for the CDX lookup or the `id_` body
 *   (connection error, non-2xx, timeout, second 429, malformed CDX). Never cached.
 */
export type SnapshotResult =
  | { status: 'text'; text: string }
  | { status: 'none' }
  | { status: 'unavailable' };

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
    epitaph?: EpitaphResult;
    spans: Array<{ start: number; end: number }>;
  }>;
}
