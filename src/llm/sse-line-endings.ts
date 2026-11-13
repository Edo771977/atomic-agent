/**
 * SSE line-ending normaliser. The SSE spec allows `\r\n`, `\r` or `\n` as a
 * line ending, and some proxies send `\r\n\r\n` between events. The stream
 * parsers split events on `\n\n` and lines on `\n`, so each decoded chunk is
 * passed through here first: every line ending becomes `\n`.
 *
 * Stateful across chunks: a `\r` that ends one chunk is held back until the
 * next one shows whether a `\n` follows it, so a `\r\n` split across two
 * reads is still one line ending, not two. Pass `final: true` on the last
 * chunk (EOF) to release a held `\r`.
 */
export interface SseLineNormaliser {
  push(text: string, final?: boolean): string;
}

export function createSseLineNormaliser(): SseLineNormaliser {
  let pendingCr = false;
  return {
    push(text, final = false) {
      let s = pendingCr ? `\r${text}` : text;
      pendingCr = false;
      if (!final && s.endsWith("\r")) {
        pendingCr = true;
        s = s.slice(0, -1);
      }
      return s.includes("\r") ? s.replace(/\r\n?/g, "\n") : s;
    },
  };
}

/** Splits one SSE event into lines on any of the spec's line endings. */
export const SSE_LINE_BREAK = /\r\n|\r|\n/;
