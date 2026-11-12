import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { CancelledError } from "../../llm/index.js";
import { BATCH_CANCEL_GRACE_MS, executeBatch, toBatchInputs } from "./batch-scheduler.js";

/**
 * A cancellation in one resource group must not return the batch while
 * another group is still running: its result would land in the slots,
 * and its `onCallFinished` fire, after the step had already moved on.
 */
describe("cancellation across resource groups", () => {
  it("waits for every group before returning, and keeps the late group's real result", async () => {
    const abort = new AbortController();
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const reg = new ToolRegistry();
    reg.register({
      name: "browser.click",
      description: "click",
      readonly: false,
      run: async () => {
        abort.abort();
        throw new CancelledError("cancelled by the operator");
      },
    });
    reg.register({
      name: "os.git.status",
      description: "status",
      readonly: true,
      // Does not honour the signal: it finishes whatever happens.
      run: async () => {
        await readGate;
        return compressToolResult({ tool: "os.git.status", status: "ok", output: "clean" });
      },
    });
    const finished: number[] = [];
    let returned = false;
    const batch = executeBatch(
      toBatchInputs([
        { tool: "os.git.status", args: {} },
        { tool: "browser.click", args: { ref: "e1" } },
      ]),
      reg,
      {
        workingDir: "/tmp",
        sessionId: "s1",
        stepIndex: 0,
        signal: abort.signal,
        toolHooks: null,
        onCallFinished: ({ batchIndex }) => {
          finished.push(batchIndex);
        },
      },
    ).then((out) => {
      returned = true;
      return out;
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(abort.signal.aborted).toBe(true);
    expect(returned).toBe(false);
    releaseRead();
    const out = await batch;
    expect(out.cancelled).toBe(true);
    expect(finished).toContain(0);
    expect(out.results[0]!.cancelled).toBe(false);
    expect(out.results[0]!.compressed?.status).toBe("ok");
    expect(out.results[1]!.compressed).toBeUndefined();
    expect(out.results[1]!.cancelled).toBe(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns after the grace when a tool ignores the abort, and drops its late result", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const reg = new ToolRegistry();
    reg.register({
      name: "browser.click",
      description: "click",
      readonly: false,
      run: async () => {
        abort.abort();
        throw new CancelledError("cancelled by the operator");
      },
    });
    reg.register({
      name: "os.git.status",
      description: "status",
      readonly: true,
      // Never looks at the signal; only the test releases it.
      run: async () => {
        await readGate;
        return compressToolResult({ tool: "os.git.status", status: "ok", output: "clean" });
      },
    });
    const finished: number[] = [];
    let returned = false;
    const batch = executeBatch(
      toBatchInputs([
        { tool: "os.git.status", args: {} },
        { tool: "browser.click", args: { ref: "e1" } },
      ]),
      reg,
      {
        workingDir: "/tmp",
        sessionId: "s1",
        stepIndex: 0,
        signal: abort.signal,
        toolHooks: null,
        onCallFinished: ({ batchIndex }) => {
          finished.push(batchIndex);
        },
      },
    ).then((out) => {
      returned = true;
      return out;
    });
    await vi.advanceTimersByTimeAsync(BATCH_CANCEL_GRACE_MS - 1);
    expect(abort.signal.aborted).toBe(true);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const out = await batch;
    expect(returned).toBe(true);
    expect(out.cancelled).toBe(true);
    expect(out.results[0]!.cancelled).toBe(true);
    expect(out.results[0]!.compressed).toBeUndefined();
    expect(out.results[1]!.cancelled).toBe(true);
    // The hung read finishes after the batch returned: nothing observes it.
    releaseRead();
    await vi.advanceTimersByTimeAsync(10);
    expect(finished).toEqual([]);
    expect(out.results[0]!.compressed).toBeUndefined();
    expect(out.results[0]!.cancelled).toBe(true);
  });
});
