import { describe, expect, it } from "vitest";

import { gbnfAccepts } from "./gbnf-test-helpers.js";
import {
  LLAMA_SERVER_GBNF_MAX_REPETITION,
  buildReasoningPreludeRules,
  withReasoningBudget,
  withUnboundedReasoningPrelude,
} from "./reasoning-prelude.js";

/** Every `{m}` / `{m,n}` bound in `grammar`, as numbers. */
function repetitionBounds(grammar: string): number[] {
  return [...grammar.matchAll(/\{(\d+)(?:,(\d*))?\}/g)].flatMap((m) =>
    m[2] === undefined || m[2] === "" ? [Number(m[1])] : [Number(m[1]), Number(m[2])],
  );
}

describe("buildReasoningPreludeRules bound vs llama.cpp's per-quantifier limit (MAX_REPETITION_THRESHOLD = 2000, #600, ATO-607)", () => {
  const SENTINEL = "</think>";

  it("keeps the one-line body at or below the limit", () => {
    expect(LLAMA_SERVER_GBNF_MAX_REPETITION).toBe(1999);
    const atBoundary = buildReasoningPreludeRules("think", SENTINEL, undefined, 1999);
    expect(atBoundary).toContain("think-body ::= think-char{0,1999}");
    expect(atBoundary).not.toContain("think-body-2");
    const small = buildReasoningPreludeRules("think", SENTINEL, undefined, 8);
    expect(small).toContain("think-body ::= think-char{0,8}");
    expect(small).not.toContain("think-body-2");
  });

  it("chains the body past the limit instead of clamping it: 2,000", () => {
    const rules = buildReasoningPreludeRules("think", SENTINEL, undefined, 2000);
    expect(rules).toContain(
      "think-body ::= think-char{0,1998} | think-char{1999} think-body-2\n" +
        "think-body-2 ::= think-char{0,1}",
    );
    expect(rules).not.toContain("think-body ::= think-char{0,1999}");
  });

  it("chains a 1,500-token budget (6,000 chars) into links that each stay under the limit", () => {
    const rules = buildReasoningPreludeRules("think", SENTINEL, undefined, 6000);
    expect(rules).toContain(
      [
        "think-body ::= think-char{0,1998} | think-char{1999} think-body-2",
        "think-body-2 ::= think-char{0,1998} | think-char{1999} think-body-3",
        "think-body-3 ::= think-char{0,1998} | think-char{1999} think-body-4",
        "think-body-4 ::= think-char{0,3}",
      ].join("\n"),
    );
    expect(rules).not.toContain("think-body-5");
    const bounds = repetitionBounds(rules);
    expect(bounds.length).toBeGreaterThan(0);
    for (const bound of bounds) expect(bound).toBeLessThanOrEqual(LLAMA_SERVER_GBNF_MAX_REPETITION);
    // The prelude still references the head rule by its old name.
    expect(rules).toContain('think-prelude ::= think-body "</think>" prelude-trail-ws');
  });

  it("admits exactly 0..6,000 characters of body, and nothing past it", () => {
    const rules = buildReasoningPreludeRules("think", SENTINEL, undefined, 6000);
    for (const length of [0, 1, 1998, 1999, 2000, 3997, 3998, 3999, 5997, 5998, 6000]) {
      expect(gbnfAccepts(rules, "think-body", "x".repeat(length))).toBe(true);
    }
    expect(gbnfAccepts(rules, "think-body", "x".repeat(6001))).toBe(false);
    // Through the whole prelude: the only way out past the bound is the sentinel.
    expect(gbnfAccepts(rules, "think-prelude", `${"x".repeat(6000)}</think>\n`)).toBe(true);
    expect(gbnfAccepts(rules, "think-prelude", `${"x".repeat(6001)}</think>\n`)).toBe(false);
    // A `<`-led unit still spans its whole prefix, across a link seam too.
    expect(gbnfAccepts(rules, "think-body", `${"x".repeat(1998)}<b${"y".repeat(10)}`)).toBe(true);
  });

  it("admits exactly 0..2,000 at the first length past the limit", () => {
    const rules = buildReasoningPreludeRules("think", SENTINEL, undefined, 2000);
    for (const length of [0, 1998, 1999, 2000]) {
      expect(gbnfAccepts(rules, "think-body", "x".repeat(length))).toBe(true);
    }
    expect(gbnfAccepts(rules, "think-body", "x".repeat(2001))).toBe(false);
  });

  it("chains an exact multiple of the limit without an empty tail beyond it", () => {
    const rules = buildReasoningPreludeRules("think", SENTINEL, undefined, 3998);
    expect(rules).toContain(
      "think-body ::= think-char{0,1998} | think-char{1999} think-body-2\n" +
        "think-body-2 ::= think-char{0,1999}",
    );
    expect(gbnfAccepts(rules, "think-body", "x".repeat(3998))).toBe(true);
    expect(gbnfAccepts(rules, "think-body", "x".repeat(3999))).toBe(false);
  });

  it("chains Gemma's channel prelude the same way, open sentinel kept", () => {
    const rules = buildReasoningPreludeRules("channel", "<channel|>", "<|channel>thought\n", 6000);
    expect(rules).toContain(
      'channel-prelude ::= "<|channel>thought\\n" channel-body "<channel|>" prelude-trail-ws',
    );
    expect(rules).toContain("channel-body ::= channel-char{0,1998} | channel-char{1999} channel-body-2");
    expect(rules).toContain("channel-body-4 ::= channel-char{0,3}");
    expect(gbnfAccepts(rules, "channel-body", "x".repeat(6000))).toBe(true);
    expect(gbnfAccepts(rules, "channel-body", "x".repeat(6001))).toBe(false);
  });

  it("keeps the unbounded form when the budget is 0", () => {
    const unbounded = buildReasoningPreludeRules("think", SENTINEL, undefined, 0);
    expect(unbounded).toContain("think-body ::= think-fragment*");
    expect(unbounded).not.toMatch(/think-char\{0,\d+\}/);
    expect(unbounded).not.toContain("think-body-2");
  });

  it("withUnboundedReasoningPrelude lifts a chained bound by its head line, every other line identical", () => {
    const chained = buildReasoningPreludeRules("think", SENTINEL, undefined, 6000);
    const lifted = withUnboundedReasoningPrelude(chained);
    expect(lifted).toContain("think-body ::= think-char*");
    expect(lifted).not.toMatch(/^think-body ::= think-char\{/m);
    const before = chained.split("\n");
    const after = lifted.split("\n");
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i += 1) {
      if (!before[i]!.startsWith("think-body ::=")) expect(after[i]).toBe(before[i]);
    }
    expect(gbnfAccepts(lifted, "think-body", "x".repeat(6001))).toBe(true);
  });

  it("withUnboundedReasoningPrelude still lifts a one-line bound", () => {
    const small = buildReasoningPreludeRules("think", SENTINEL, undefined, 1999);
    const lifted = withUnboundedReasoningPrelude(small);
    expect(lifted).toContain("think-body ::= think-char*");
    expect(lifted).not.toContain("think-char{0,1999}");
  });
});

describe("withReasoningBudget re-bounds the prelude per request (a local fusion worker)", () => {
  const SENTINEL = "</think>";
  const grammarWith = (stem: string, sentinel: string, open: string | undefined, chars: number) =>
    `root ::= ${stem}-prelude tool-call-array\n${buildReasoningPreludeRules(stem, sentinel, open, chars)}\ntool-call-array ::= "["\n`;

  it("bounds an unbounded prelude, deriving the one-character unit from the fragment rule", () => {
    const base = grammarWith("think", SENTINEL, undefined, 0);
    const bounded = withReasoningBudget(base, 6000);
    // The same rules a base grammar built with that bound carries.
    for (const line of buildReasoningPreludeRules("think", SENTINEL, undefined, 6000).split("\n")) {
      expect(bounded.split("\n")).toContain(line);
    }
    expect(gbnfAccepts(bounded, "think-body", "x".repeat(6000))).toBe(true);
    expect(gbnfAccepts(bounded, "think-body", "x".repeat(6001))).toBe(false);
    expect(gbnfAccepts(bounded, "think-body", "a</b".repeat(100))).toBe(true);
  });

  it("replaces a chained bound with the new one, leaving no stale chain rule", () => {
    const base = grammarWith("think", SENTINEL, undefined, 8000);
    const tighter = withReasoningBudget(base, 2048);
    expect(tighter).not.toMatch(/^think-body-[3-9] ::= /m);
    expect(gbnfAccepts(tighter, "think-body", "x".repeat(2048))).toBe(true);
    expect(gbnfAccepts(tighter, "think-body", "x".repeat(2049))).toBe(false);
    const looser = withReasoningBudget(grammarWith("think", SENTINEL, undefined, 1024), 8000);
    expect(gbnfAccepts(looser, "think-body", "x".repeat(8000))).toBe(true);
    expect(gbnfAccepts(looser, "think-body", "x".repeat(8001))).toBe(false);
  });

  it("gives back the same bytes for the bound the base already has", () => {
    for (const chars of [1024, 6000]) {
      const base = grammarWith("think", SENTINEL, undefined, chars);
      expect(withReasoningBudget(base, chars)).toBe(base);
    }
  });

  it("works on the Gemma channel stem and keeps its forced opener", () => {
    const base = grammarWith("channel", "<channel|>", "<|channel>thought\n", 0);
    const bounded = withReasoningBudget(base, 3000);
    expect(bounded).toContain('channel-prelude ::= "<|channel>thought\\n" channel-body');
    expect(gbnfAccepts(bounded, "channel-body", "x".repeat(3000))).toBe(true);
    expect(gbnfAccepts(bounded, "channel-body", "x".repeat(3001))).toBe(false);
  });

  it("is the identity on a grammar without a prelude, and lifts the bound at 0", () => {
    const plain = 'root ::= tool-call-array\ntool-call-array ::= "["\n';
    expect(withReasoningBudget(plain, 2048)).toBe(plain);
    const base = grammarWith("think", SENTINEL, undefined, 1024);
    expect(withReasoningBudget(base, 0)).toBe(withUnboundedReasoningPrelude(base));
  });
});
