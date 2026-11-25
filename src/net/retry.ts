import type { Probe } from '../core/types.js';

/** True when the first probe is a 5xx the fetcher did not already settle. */
export function shouldRetry(probe: Probe): boolean {
  return (
    probe.outcome === 'response' &&
    probe.status !== undefined &&
    probe.status >= 500 &&
    probe.status <= 599 &&
    !probe.noRetry
  );
}
