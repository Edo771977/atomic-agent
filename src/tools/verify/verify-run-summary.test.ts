import { describe, expect, it } from "vitest";

import { renderVerifyRunSummary } from "./verify-run-summary.js";
import type { VerifyRunResult } from "./run-verify.js";

const TOKEN = `ghp_${"A1b2C3d4E5".repeat(4).slice(0, 36)}`;

function failedCommand(stderrTail: string): VerifyRunResult {
  return {
    kind: "command",
    ok: false,
    isolated: true,
    checks: [{ check: "exit 0", ok: false, detail: "exit 1" }],
    exitCode: 1,
    durationMs: 10,
    stdoutTail: "",
    stderrTail,
  } as unknown as VerifyRunResult;
}

describe("renderVerifyRunSummary", () => {
  it("masks a secret in an output tail before clipping it", () => {
    // The token straddles the 1,500-char tail clip: once clipped, only
    // its end would be left, which the detector no longer recognises.
    const tail = `token=${TOKEN}${"x".repeat(1_490)}`;
    const summary = renderVerifyRunSummary(failedCommand(tail));
    expect(summary).not.toContain(TOKEN.slice(-6));
    expect(summary).not.toContain(TOKEN);
  });

  it("keeps an ordinary tail as it was", () => {
    const summary = renderVerifyRunSummary(failedCommand("AssertionError: expected 2 to be 3"));
    expect(summary).toContain("AssertionError: expected 2 to be 3");
  });
});
