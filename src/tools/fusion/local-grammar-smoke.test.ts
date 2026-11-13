import { describe, expect, it, vi } from "vitest";

import type { RunTurnResult } from "../../agent/agent-loop.js";
import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import type { GrammarSmokeVerdict } from "../../llm/grammar/grammar-smoke.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ToolContext } from "../tool-registry.js";
import {
  FAILURE_BREAKER_INSTRUCTION,
  TOOL_PROTOCOL_LABEL,
  TOOL_PROTOCOL_SIGNATURE,
  classifyWorkerFailure,
} from "./failure-breaker.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";
import {
  FORMAT_CHECK_FAIL_TTL_MS,
  FORMAT_CHECK_INCONCLUSIVE_TTL_MS,
  LocalGrammarSmoke,
  describeFormatCheckRefusal,
  formatCheckTrip,
  type LocalGrammarProbe,
} from "./local-grammar-smoke.js";
import { FusionTurnBudget } from "./turn-budget.js";

const FAIL: GrammarSmokeVerdict = {
  kind: "fail",
  cause: "reply-unparsed",
  error: 'tool-call protocol mismatch: invalid tool-call JSON (reply began "Sure")',
};

function probe(verdicts: GrammarSmokeVerdict[], key = "srv\u0000model\u0000qwen-think") {
  const run = vi.fn(async (_signal?: AbortSignal) => verdicts.shift() ?? { kind: "pass" as const });
  const p: LocalGrammarProbe = { key, server: "srv", run };
  return { probe: p, run };
}

describe("LocalGrammarSmoke", () => {
  it("keeps a pass and a failure per (server, model, profile) for the process", async () => {
    const smoke = new LocalGrammarSmoke();
    const passing = probe([{ kind: "pass" }], "a");
    const at = { sessionId: "s1", leg: "local-llama" };
    expect(await smoke.check(passing.probe, at)).toEqual({ kind: "pass", cached: false });
    expect(await smoke.check(passing.probe, { ...at, sessionId: "s2" })).toEqual({
      kind: "pass",
      cached: true,
    });
    expect(passing.run).toHaveBeenCalledOnce();

    const failing = probe([FAIL], "b");
    expect(await smoke.check(failing.probe, at)).toMatchObject({ kind: "fail", cached: false });
    expect(await smoke.check(failing.probe, at)).toMatchObject({ kind: "fail", cached: true });
    expect(failing.run).toHaveBeenCalledOnce();

    // Another model or profile on the same server is asked afresh.
    const other = probe([{ kind: "pass" }], "a-other-model");
    await smoke.check(other.probe, at);
    expect(other.run).toHaveBeenCalledOnce();
  });

  it("keeps a failure for ten minutes only, then asks again", async () => {
    let now = 1_000_000;
    const smoke = new LocalGrammarSmoke({ now: () => now });
    const p = probe([FAIL, { kind: "pass" }]);
    const at = { sessionId: "s1", leg: "local-llama" };
    expect(await smoke.check(p.probe, at)).toMatchObject({ kind: "fail", cached: false });
    now += FORMAT_CHECK_FAIL_TTL_MS - 1;
    expect(await smoke.check(p.probe, at)).toMatchObject({ kind: "fail", cached: true });
    now += 1;
    expect(await smoke.check(p.probe, at)).toEqual({ kind: "pass", cached: false });
    // A pass is kept for the process.
    now += 24 * 60 * 60_000;
    expect(await smoke.check(p.probe, at)).toEqual({ kind: "pass", cached: true });
    expect(p.run).toHaveBeenCalledTimes(2);
  });

  it("keeps nothing for a probe with no key (an unknown model id)", async () => {
    const smoke = new LocalGrammarSmoke();
    const p = probe([FAIL, { kind: "pass" }]);
    const keyless: LocalGrammarProbe = { ...p.probe, key: null };
    const at = { sessionId: "s1", leg: "local-llama" };
    expect(await smoke.check(keyless, at)).toMatchObject({ kind: "fail", cached: false });
    expect(await smoke.check(keyless, at)).toEqual({ kind: "pass", cached: false });
    expect(p.run).toHaveBeenCalledTimes(2);
  });

  it("drops a kept failure once a worker on that leg finished with a tool call", async () => {
    const smoke = new LocalGrammarSmoke();
    const p = probe([FAIL, { kind: "pass" }]);
    expect(await smoke.check(p.probe, { sessionId: "s1", leg: "local-llama" })).toMatchObject({
      kind: "fail",
    });
    smoke.noteWorkerSucceeded("s1", "local-llama");
    // Another session asks afresh instead of reading the stale failure.
    expect(await smoke.check(p.probe, { sessionId: "s2", leg: "local-llama" })).toEqual({
      kind: "pass",
      cached: false,
    });
  });

  it("keeps a timeout for two minutes, so a busy server is not asked before every fan-out", async () => {
    let now = 0;
    const smoke = new LocalGrammarSmoke({ now: () => now });
    const flaky = probe([
      { kind: "inconclusive", reason: "timeout", detail: "no answer within 10 s" },
      { kind: "pass" },
    ]);
    const at = { sessionId: "s1", leg: "local-llama" };
    expect(await smoke.check(flaky.probe, at)).toMatchObject({
      kind: "inconclusive",
      reason: "timeout",
      cached: false,
    });
    now += FORMAT_CHECK_INCONCLUSIVE_TTL_MS - 1;
    expect(await smoke.check(flaky.probe, at)).toMatchObject({ kind: "inconclusive", cached: true });
    now += 1;
    expect(await smoke.check(flaky.probe, at)).toEqual({ kind: "pass", cached: false });
    expect(flaky.run).toHaveBeenCalledTimes(2);
  });

  it("keeps nothing from a cancel", async () => {
    const smoke = new LocalGrammarSmoke();
    const p = probe([
      { kind: "inconclusive", reason: "cancelled", detail: "cancelled while the check ran" },
      { kind: "pass" },
    ]);
    const at = { sessionId: "s1", leg: "local-llama" };
    await smoke.check(p.probe, at);
    expect(await smoke.check(p.probe, at)).toEqual({ kind: "pass", cached: false });
  });

  it("skips a server a live fan-out is loading, and one whose slots are all working", async () => {
    const smoke = new LocalGrammarSmoke();
    const p = probe([{ kind: "pass" }]);
    const at = { sessionId: "s2", leg: "local-llama" };
    const end = smoke.beginFanout(["srv"]);
    expect(await smoke.check(p.probe, at)).toEqual({ kind: "skipped", why: "server-busy" });
    // Another server is not held by that fan-out.
    const other = probe([{ kind: "pass" }], "other");
    expect(await smoke.check({ ...other.probe, server: "other-srv" }, at)).toMatchObject({
      kind: "pass",
    });
    end();
    end(); // idempotent
    let busy = true;
    const slots: LocalGrammarProbe = { ...p.probe, allSlotsBusy: async () => busy };
    expect(await smoke.check(slots, at)).toEqual({ kind: "skipped", why: "server-busy" });
    busy = false;
    expect(await smoke.check(slots, at)).toEqual({ kind: "pass", cached: false });
    expect(p.run).toHaveBeenCalledOnce();
    // An unreadable slot table says nothing: the check runs.
    const unreadable = probe([{ kind: "pass" }], "u");
    const throwing: LocalGrammarProbe = {
      ...unreadable.probe,
      allSlotsBusy: async () => {
        throw new Error("no /slots");
      },
    };
    expect(await smoke.check(throwing, at)).toMatchObject({ kind: "pass" });
  });

  it("asks once for two checks in flight", async () => {
    const smoke = new LocalGrammarSmoke();
    let release!: (v: GrammarSmokeVerdict) => void;
    const run = vi.fn(() => new Promise<GrammarSmokeVerdict>((resolve) => (release = resolve)));
    const p = { key: "k", server: "srv", run };
    const at = { sessionId: "s1", leg: "local-llama" };
    const first = smoke.check(p, at);
    const second = smoke.check(p, at);
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    release({ kind: "pass" });
    expect(await first).toEqual({ kind: "pass", cached: false });
    expect(await second).toEqual({ kind: "pass", cached: true });
    expect(run).toHaveBeenCalledOnce();
  });

  it("skips a leg a worker already succeeded on this session, and a cancelled call", async () => {
    const smoke = new LocalGrammarSmoke();
    const p = probe([FAIL]);
    smoke.noteWorkerSucceeded("s1", "local-llama");
    expect(await smoke.check(p.probe, { sessionId: "s1", leg: "local-llama" })).toEqual({
      kind: "skipped",
      why: "worker-succeeded",
    });
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await smoke.check(p.probe, { sessionId: "s2", leg: "local-llama", signal: aborted.signal }),
    ).toEqual({ kind: "skipped", why: "cancelled" });
    expect(p.run).not.toHaveBeenCalled();
  });

  it("passes the caller's signal to the probe and turns a throw into no verdict", async () => {
    const smoke = new LocalGrammarSmoke();
    const controller = new AbortController();
    const run = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const verdict = await smoke.check(
      { key: "k", server: "srv", run },
      { sessionId: "s", leg: "l", signal: controller.signal },
    );
    expect(run).toHaveBeenCalledWith(controller.signal);
    expect(verdict).toMatchObject({ kind: "inconclusive", reason: "unreachable" });
  });

  it("refuses in the breaker's own protocol-mismatch words", () => {
    const trip = formatCheckTrip("local-llama");
    expect(trip).toMatchObject({ signature: TOOL_PROTOCOL_SIGNATURE, blocker: true, label: TOOL_PROTOCOL_LABEL });
    const message = describeFormatCheckRefusal(trip, FAIL.kind === "fail" ? FAIL.error : "", "small");
    expect(message).toContain(TOOL_PROTOCOL_LABEL);
    expect(message).toContain("another worker on this leg would fail the same way");
    expect(message).toContain(FAILURE_BREAKER_INSTRUCTION);
    // A row with the check's error would be classified the same way.
    expect(
      classifyWorkerFailure({ status: "failed", error: FAIL.kind === "fail" ? FAIL.error : "" }),
    ).toMatchObject({ blocker: true, signature: TOOL_PROTOCOL_SIGNATURE });
  });
});

const logger = new StructuredLogger({ level: "error", sinks: [] });

function fusionMode(over: Partial<ResolvedRunMode> = {}): ResolvedRunMode {
  return {
    stored: "fusion",
    effective: "fusion",
    orchestratorProviderId: "openrouter",
    orchestratorModel: "big",
    workerProviderId: "local-llama",
    workerModel: "small",
    workers: 2,
    workersPinned: true,
    workerMaxSteps: 7,
    workerTimeoutMs: 60_000,
    primaryProviderId: "openrouter",
    degraded: null,
    ...over,
  };
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/repo",
    sessionId: "s-parent",
    stepIndex: 0,
    signal: new AbortController().signal,
    ...over,
  };
}

const workerTurn: FusionDelegateDeps["runTurn"] = async (_session, _message, options) => {
  options.eventHook?.({
    type: "llm_event",
    event: {
      type: "tool_call_executed",
      result: { tool: "os.fs.read", status: "ok", summary: "read", details: {}, truncated: false },
      batchIndex: 0,
      batchSize: 1,
    },
  });
  options.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: "done" } });
  const result: RunTurnResult = {
    session: createEmptySessionState({ id: "s-w", workingDir: "/repo" }),
    reason: "reply",
    stepCount: 2,
  };
  return result;
};

function deps(over: Partial<FusionDelegateDeps> = {}): FusionDelegateDeps {
  let minted = 0;
  return {
    runTurn: vi.fn(workerTurn),
    createEphemeralSession: (meta) => {
      minted += 1;
      return createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
        workingDir: "/repo",
        metadata: { fusionWorker: { ...meta } },
      });
    },
    approvals: {
      setSessionPolicy: () => {},
      clearSessionPolicy: () => {},
      fanoutScopes: new FanoutScopeRegistry(),
    },
    approvalRequired: false,
    emitEvent: () => {},
    workingDir: "/repo",
    slotManager: { poolSize: () => 2 },
    resolveRunMode: () => fusionMode(),
    workerSupportsSlotAffinity: () => true,
    warmWorkerBackend: async () => {},
    outputCharCap: 4000,
    logger,
    ...over,
  };
}

const TASKS = [
  { id: "t1", title: "One", instructions: "Do one" },
  { id: "t2", title: "Two", instructions: "Do two" },
];

describe("fusion.delegate with the local format check", () => {
  it("refuses the fan-out up front when the check fails, and notes the blocker on the turn", async () => {
    const failing = probe([FAIL]);
    const turnBudget = new FusionTurnBudget();
    const d = deps({ localGrammarProbeFor: () => failing.probe, turnBudget });
    const tool = buildFusionDelegateTool(d);
    const result = await tool.run({ tasks: TASKS }, ctx());
    expect(result.status).toBe("error");
    const output = result.fullOutput ?? "";
    expect(output).toMatch(/^fusion\.delegate did not run: the fan-out was stopped because /);
    expect(output).toContain(TOOL_PROTOCOL_LABEL);
    expect(output).toContain("one short completion on small under the workers' grammar");
    expect(output).toContain("tool-call protocol mismatch: invalid tool-call JSON");
    expect(output).toContain(FAILURE_BREAKER_INSTRUCTION);
    expect(result.details).toMatchObject({ reason: "failure-breaker", blocker: true, formatCheck: true });
    expect(d.runTurn).not.toHaveBeenCalled();
    expect(turnBudget.trips("s-parent")).toEqual([formatCheckTrip("local-llama")]);

    // The trip refuses the next delegation this turn, as any blocker does.
    const sameTurn = await tool.run({ tasks: TASKS }, ctx());
    expect(sameTurn.fullOutput).toMatch(/did not run: earlier this turn/);
    expect(failing.run).toHaveBeenCalledOnce();
  });

  it("keeps the failure for the process: a later turn is refused without asking again", async () => {
    const failing = probe([FAIL]);
    const d = deps({ localGrammarProbeFor: () => failing.probe });
    const tool = buildFusionDelegateTool(d);
    expect((await tool.run({ tasks: TASKS }, ctx())).status).toBe("error");
    const later = await tool.run({ tasks: TASKS }, ctx());
    expect(later.status).toBe("error");
    expect(later.fullOutput).toContain("one short completion on small under the workers' grammar");
    expect(failing.run).toHaveBeenCalledOnce();
    expect(d.runTurn).not.toHaveBeenCalled();
  });

  it("runs the workers after a pass, and does not ask again for the next fan-out", async () => {
    const passing = probe([{ kind: "pass" }]);
    const d = deps({ localGrammarProbeFor: vi.fn(() => passing.probe) });
    const tool = buildFusionDelegateTool(d);
    expect((await tool.run({ tasks: TASKS }, ctx())).status).toBe("ok");
    expect(d.runTurn).toHaveBeenCalledTimes(2);
    expect((await tool.run({ tasks: TASKS }, ctx())).status).toBe("ok");
    expect(passing.run).toHaveBeenCalledOnce();
  });

  it("skips the check on a leg whose worker already ran tools this session", async () => {
    const smoke = new LocalGrammarSmoke();
    const first = probe([{ kind: "pass" }], "first");
    const tool = buildFusionDelegateTool(
      deps({ localGrammarSmoke: smoke, localGrammarProbeFor: () => first.probe }),
    );
    expect((await tool.run({ tasks: TASKS }, ctx())).status).toBe("ok");
    // A model switch changes the key; the leg already proved itself here.
    const second = probe([FAIL], "second");
    const after = buildFusionDelegateTool(
      deps({ localGrammarSmoke: smoke, localGrammarProbeFor: () => second.probe }),
    );
    expect((await after.run({ tasks: TASKS }, ctx())).status).toBe("ok");
    expect(second.run).not.toHaveBeenCalled();
    // Another session has proved nothing yet.
    expect((await after.run({ tasks: TASKS }, ctx({ sessionId: "s-other" }))).status).toBe("error");
  });

  it("does not queue a check behind another session's live fan-out on the same server", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    const runTurn: FusionDelegateDeps["runTurn"] = async (session, message, options) => {
      started += 1;
      await gate;
      return workerTurn(session, message, options);
    };
    const first = probe([{ kind: "pass" }], "first-key");
    const later = probe([FAIL], "later-key");
    const smoke = new LocalGrammarSmoke();
    let current = first.probe;
    const tool = buildFusionDelegateTool(
      deps({ runTurn: vi.fn(runTurn), localGrammarSmoke: smoke, localGrammarProbeFor: () => current }),
    );
    const running = tool.run({ tasks: TASKS }, ctx());
    await vi.waitFor(() => expect(started).toBeGreaterThan(0));
    current = later.probe;
    const second = tool.run({ tasks: TASKS }, ctx({ sessionId: "s-other" }));
    await vi.waitFor(() => expect(started).toBeGreaterThan(2));
    release();
    expect((await running).status).toBe("ok");
    expect((await second).status).toBe("ok");
    expect(later.run).not.toHaveBeenCalled();
    // Once nothing is live there, the next fan-out is checked again.
    expect((await tool.run({ tasks: TASKS }, ctx({ sessionId: "s-third" }))).status).toBe("error");
    expect(later.run).toHaveBeenCalledOnce();
  });

  it("never asks a cloud leg", async () => {
    const probeFor = vi.fn(() => probe([FAIL]).probe);
    const d = deps({
      workerSupportsSlotAffinity: () => false,
      localGrammarProbeFor: probeFor,
    });
    expect((await buildFusionDelegateTool(d).run({ tasks: TASKS }, ctx())).status).toBe("ok");
    expect(probeFor).not.toHaveBeenCalled();
  });

  it("sends workers unchecked when localFormatCheck is off, or no probe answers for the leg", async () => {
    const failing = probe([FAIL]);
    const off = deps({
      resolveRunMode: () => fusionMode({ localFormatCheck: false }),
      localGrammarProbeFor: () => failing.probe,
    });
    expect((await buildFusionDelegateTool(off).run({ tasks: TASKS }, ctx())).status).toBe("ok");
    const noProbe = deps({ localGrammarProbeFor: () => undefined });
    expect((await buildFusionDelegateTool(noProbe).run({ tasks: TASKS }, ctx())).status).toBe("ok");
    expect(failing.run).not.toHaveBeenCalled();
  });

  it("dispatches as before when the check has no verdict", async () => {
    const silent = probe([{ kind: "inconclusive", reason: "timeout", detail: "no answer within 30 s" }]);
    const d = deps({ localGrammarProbeFor: () => silent.probe });
    expect((await buildFusionDelegateTool(d).run({ tasks: TASKS }, ctx())).status).toBe("ok");
    expect(d.runTurn).toHaveBeenCalledTimes(2);
  });

  it("hands the tool call's cancellation to the check", async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const watching: LocalGrammarProbe = {
      key: "k",
      server: "srv",
      run: async (signal) => {
        seen.push(signal);
        return { kind: "pass" };
      },
    };
    await buildFusionDelegateTool(deps({ localGrammarProbeFor: () => watching })).run(
      { tasks: TASKS },
      ctx({ signal: controller.signal }),
    );
    expect(seen).toEqual([controller.signal]);
  });
});
