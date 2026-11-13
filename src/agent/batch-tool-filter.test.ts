import { describe, expect, it, vi } from "vitest";
import { executeBatch } from "./batch-executor.js";
import { resourceClassFor } from "./tool-resource-class.js";
import { ToolRegistry } from "../tools/tool-registry.js";

describe("batch turn tool filter", () => {
  function fixture() {
    const order: string[] = [];
    const registry = new ToolRegistry();
    for (const name of ["memory.notes.store", "os.fs.read", "skill.view", "reply"]) {
      registry.register({
        name, description: name, readonly: true,
        run: async () => {
          await Promise.resolve();
          order.push(name);
          return { tool: name, status: "ok", summary: name, details: {}, truncated: false };
        },
      });
    }
    const inputs = (names: string[]) => names.map((tool, batchIndex) => ({
      batchIndex, call: { tool, args: tool === "skill.view" ? { name: "loaded" } : {} }, resourceClass: resourceClassFor(tool),
    }));
    const ctx = { workingDir: "/fixture", sessionId: "s-w-test", stepIndex: 0, signal: new AbortController().signal, toolHooks: null };
    return { order, registry, inputs, ctx };
  }

  it("refuses excluded siblings while allowed work still settles before the terminal", async () => {
    const { order, registry, inputs, ctx } = fixture();
    const finished = vi.fn();
    const outcome = await executeBatch(inputs(["memory.notes.store", "os.fs.read", "reply"]), registry, {
      ...ctx, ...{ toolFilter: (name: string) => name !== "memory.notes.store" }, onCallFinished: finished,
    });
    expect(order).toEqual(["os.fs.read", "reply"]);
    expect(outcome.results.map(result => [result.batchIndex, result.compressed?.status])).toEqual([[0, "error"], [1, "ok"], [2, "ok"]]);
    expect(finished).toHaveBeenCalledTimes(3);
    expect(outcome.cancelled).toBe(false);
  });

  it("checks the filter before an already-loaded skill shortcut", async () => {
    const { registry, inputs, ctx } = fixture();
    const outcome = await executeBatch(inputs(["skill.view"]), registry, {
      ...ctx, ...{ toolFilter: (name: string) => name !== "skill.view" }, loadedSkillNames: new Set(["loaded"]),
    });
    expect(outcome.results[0]?.compressed).toMatchObject({ status: "error", details: { tool_filter: true } });
    expect(outcome.results[0]?.compressed?.details.skillAlreadyLoaded).toBeUndefined();
  });

  it("keeps cancellation ahead of policy refusals", async () => {
    const { order, registry, inputs, ctx } = fixture();
    const abort = new AbortController();
    abort.abort();
    const outcome = await executeBatch(inputs(["memory.notes.store", "reply"]), registry, {
      ...ctx, signal: abort.signal, ...{ toolFilter: () => false },
    });
    expect(outcome.cancelled).toBe(true);
    expect(outcome.results.every(result => result.cancelled && result.compressed === undefined)).toBe(true);
    expect(order).toEqual([]);
  });
});
