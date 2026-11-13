import { describe, expect, it } from "vitest";

import { createSseLineNormaliser, SSE_LINE_BREAK } from "./sse-line-endings.js";

describe("createSseLineNormaliser", () => {
  it("turns CRLF, CR and LF line endings into LF", () => {
    const n = createSseLineNormaliser();
    expect(n.push("a\r\nb\rc\nd", true)).toBe("a\nb\nc\nd");
  });

  it("holds a trailing CR so a CRLF split across chunks is one line ending", () => {
    const n = createSseLineNormaliser();
    expect(n.push("data: x\r\n\r")).toBe("data: x\n");
    expect(n.push("\ndata: y")).toBe("\ndata: y");
  });

  it("reads a held CR followed by a non-LF as its own line ending", () => {
    const n = createSseLineNormaliser();
    expect(n.push("a\r")).toBe("a");
    expect(n.push("b")).toBe("\nb");
  });

  it("releases a held CR on the final chunk", () => {
    const n = createSseLineNormaliser();
    expect(n.push("a\r")).toBe("a");
    expect(n.push("", true)).toBe("\n");
  });

  it("splits an event on any line ending", () => {
    expect("a\r\nb\rc\nd".split(SSE_LINE_BREAK)).toEqual(["a", "b", "c", "d"]);
  });
});
