/**
 * readCapped(response, maxBytes) — read a response body into bytes, stopping at the cap.
 *
 * The one body reader for the fetcher, the GitHub README resolver and the Wayback client.
 * When the cap is reached the stream is cancelled (the connection is released) and the
 * truncated bytes are returned as if they were the whole body. A missing body (null body,
 * e.g. 204) reads as empty. Read errors (abort, reset) propagate to the caller.
 */

export const MAX_BODY_BYTES = 524_288; // 512 KB

export async function readCapped(
  response: Response,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array(await response.arrayBuffer()).slice(0, maxBytes);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - total;
    const piece = value.length > room ? value.slice(0, room) : value;
    chunks.push(piece);
    total += piece.length;
  }
  if (total >= maxBytes) await reader.cancel().catch(() => undefined);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Release a body that will not be read (frees the connection slot). Never throws. */
export async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder('utf-8').decode(bytes);
