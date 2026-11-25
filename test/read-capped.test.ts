import { describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES, readCapped } from '../src/net/read-capped.js';

/** A response whose stream yields `chunks` and records whether it was cancelled. */
function streamed(chunks: Uint8Array[]): { response: Response; state: { cancelled: boolean; pulls: number } } {
  const state = { cancelled: false, pulls: 0 };
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1;
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(body), state };
}

describe('readCapped', () => {
  it('passes a small body through unchanged and does not cancel', async () => {
    const { response, state } = streamed([new TextEncoder().encode('hello '), new TextEncoder().encode('world')]);
    const bytes = await readCapped(response);
    expect(new TextDecoder().decode(bytes)).toBe('hello world');
    expect(state.cancelled).toBe(false);
  });

  it('stops at 512 KB, cancels the stream and does not read further', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(97);
    // 16 chunks = 1 MB offered; only 8 fit under the cap.
    const { response, state } = streamed(Array.from({ length: 16 }, () => chunk));
    const bytes = await readCapped(response);
    expect(MAX_BODY_BYTES).toBe(524_288);
    expect(bytes.length).toBe(MAX_BODY_BYTES);
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBeLessThan(16);
  });

  it('truncates inside a chunk that crosses the cap', async () => {
    const { response, state } = streamed([new Uint8Array(10).fill(1), new Uint8Array(10).fill(2)]);
    const bytes = await readCapped(response, 15);
    expect(Array.from(bytes)).toEqual([...Array(10).fill(1), ...Array(5).fill(2)]);
    expect(state.cancelled).toBe(true);
  });

  it('reads a missing body as empty', async () => {
    expect((await readCapped(new Response(null, { status: 204 }))).length).toBe(0);
    expect((await readCapped(new Response(''))).length).toBe(0);
  });
});
