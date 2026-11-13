import { describe, expect, it } from "vitest";

import { TurnUsageMeter, completionUsageForTurn } from "../../analytics/index.js";
import type { CompletionResult } from "../../llm/provider/completion-types.js";
import { claudeCliAdapter } from "../../llm/provider/subscription-cli/claude-cli-adapter.js";
import { codexCliAdapter } from "../../llm/provider/subscription-cli/codex-cli-adapter.js";
import { FusionTurnLedger } from "./turn-receipt.js";

/**
 * The receipt's cache hit share for a subscription CLI orchestrator: the
 * adapters' own parse of recorded CLI output, through the turn usage
 * meter, into the ledger, as the runtime wires them. Both adapters report
 * the cache figure only as the result's top-level `cacheHitTokens`.
 */

/** `claude -p --output-format json` result envelope (as in the adapter's own test). */
const CLAUDE_ENVELOPE = JSON.stringify({
  is_error: false,
  duration_api_ms: 4630,
  stop_reason: "end_turn",
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 5777,
    cache_read_input_tokens: 3289,
    output_tokens: 4,
  },
  modelUsage: { "strong-model": { contextWindow: 1_000_000, maxOutputTokens: 64_000 } },
  subtype: "success",
  api_error_status: null,
  result: "OK",
  type: "result",
});

/** `codex exec --json` output (as in the adapter's own test). */
const CODEX_OUTPUT = [
  JSON.stringify({ type: "thread.started", thread_id: "01a0" }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "OK" } }),
  JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 13459,
      cached_input_tokens: 5888,
      cache_write_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 27,
    },
  }),
].join("\n");

function receiptFor(providerId: string, result: CompletionResult) {
  const ledger = new FusionTurnLedger();
  const meter = new TurnUsageMeter({
    onRecord: (sessionId, record) => ledger.noteCompletion(sessionId, record),
  });
  meter.begin("s1", providerId);
  ledger.begin("s1", { providerId, model: "strong" });
  meter.recordServed("s1", providerId);
  const usage = completionUsageForTurn(result);
  meter.record({ sessionId: "s1", ...(usage === undefined ? {} : { usage }) });
  return { receipt: ledger.finish("s1")!, snapshot: meter.snapshot("s1") };
}

describe("fusion turn receipt with a subscription CLI orchestrator", () => {
  it("shows claude's cache reads as a share of the whole prompt (writes and reads included)", () => {
    const { receipt, snapshot } = receiptFor(
      "claude-cli",
      claudeCliAdapter.parseResult(CLAUDE_ENVELOPE, "strong"),
    );
    // 2 + 5777 + 3289: the adapter's prompt counts every input share.
    expect(receipt.record.orchestrator.tokensIn).toBe(9068);
    expect(receipt.record.orchestrator.cachedTokens).toBe(3289);
    expect(snapshot.cachedTokens).toBe(3289);
    expect(receipt.line).toContain("cache hit 36%");
  });

  it("shows codex's cached input as a share of its input, which already includes it", () => {
    const { receipt } = receiptFor("codex-cli", codexCliAdapter.parseResult(CODEX_OUTPUT, ""));
    expect(receipt.record.orchestrator.tokensIn).toBe(13459);
    expect(receipt.record.orchestrator.cachedTokens).toBe(5888);
    expect(receipt.line).toContain("cache hit 44%");
  });
});
