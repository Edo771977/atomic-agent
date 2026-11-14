import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunTurnResult } from "../../agent/agent-contract.js";
import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";
import type { DelegateTask } from "./delegate-args.js";
import type { WorkerTaskResult } from "./worker-result.js";
import { FusionTurnBudget } from "./turn-budget.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "fusion-concurrency-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

const role = (providerId: string) => ({ providerId, model: providerId, local: false });
function mode(over: Partial<ResolvedRunMode> = {}): ResolvedRunMode {
  return { stored: "fusion", effective: "fusion", orchestratorProviderId: "strong", orchestratorModel: "strong", workerProviderId: "main", workerModel: "main", workers: 4, workersPinned: true, cloudWorkers: 4, workerMaxSteps: 7, workerTimeoutMs: 60_000, primaryProviderId: "strong", degraded: null,
    roles: { byRole: { build: role("builder"), review: role("reviewer") }, mixLocalModels: false, localLegProviderIds: [] }, ...over };
}
const main: DelegateTask = { id: "main", title: "Main", instructions: "work" };
const build: DelegateTask = { id: "build", title: "Build", instructions: "work", role: "build" };
const review: DelegateTask = { id: "review", title: "Review", instructions: "work", role: "review" };
const strong: DelegateTask = { id: "strong", title: "Strong", instructions: "work", model: "orchestrator" };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The public delegate and actual runner; only the runtime's turn body is held. */
function harness(over: Partial<FusionDelegateDeps> = {}, resolved = mode()) {
  let minted = 0;
  let active = 0;
  let peak = 0;
  const started: string[] = [];
  const pending: Array<() => void> = [];
  const perProvider = new Map<string, number>();
  // Running turns' providers, sampled at every start.
  const snapshots: string[][] = [];
  const running: string[] = [];
  const peaks = new Map<string, number>();
  const deps: FusionDelegateDeps = {
    createEphemeralSession: (meta) => createEmptySessionState({ id: `__fusion_worker__${++minted}`, workingDir: dir, metadata: { fusionWorker: meta } }),
    runTurn: async (session, _message, options) => {
      const id = (session.metadata?.fusionWorker as { taskId: string }).taskId;
      const provider = options.providerId!;
      started.push(id);
      running.push(provider);
      snapshots.push([...running]);
      active++;
      peak = Math.max(peak, active);
      perProvider.set(provider, (perProvider.get(provider) ?? 0) + 1);
      peaks.set(provider, Math.max(peaks.get(provider) ?? 0, perProvider.get(provider)!));
      try {
        await new Promise<void>((resolve, reject) => {
          const finish = () => { options.signal?.removeEventListener("abort", abort); resolve(); };
          const abort = () => { options.signal?.removeEventListener("abort", abort); reject(new DOMException("stopped", "AbortError")); };
          pending.push(finish);
          if (options.signal?.aborted) abort();
          else options.signal?.addEventListener("abort", abort, { once: true });
        });
        return { session, reason: "reply", stepCount: 1 } satisfies RunTurnResult;
      } finally {
        active--;
        running.splice(running.indexOf(provider), 1);
        perProvider.set(provider, perProvider.get(provider)! - 1);
      }
    },
    approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {}, fanoutScopes: new FanoutScopeRegistry() },
    approvalRequired: false, emitEvent: () => {}, workingDir: dir,
    slotManager: { poolSize: () => 4 }, resolveRunMode: () => resolved,
    workerSupportsSlotAffinity: () => false, warmWorkerBackend: async () => {}, outputCharCap: 4000,
    logger: new StructuredLogger({ level: "error", sinks: [] }), ...over,
  };
  const tool = buildFusionDelegateTool(deps);
  return {
    start: (tasks: DelegateTask[], maxWorkers: number | undefined, signal = new AbortController().signal, sessionId = "parent") =>
      tool.run(maxWorkers === undefined ? { tasks } : { tasks, maxWorkers }, { workingDir: dir, sessionId, stepIndex: 0, signal }),
    started, pending, peaks,
    /** The most turns on `providers` that ever ran at once. */
    localPeak: (providers: ReadonlySet<string>) => Math.max(0, ...snapshots.map((s) => s.filter((p) => providers.has(p)).length)),
    get active() { return active; }, get peak() { return peak; }, get minted() { return minted; },
    async drain(count: number) {
      for (let i = 0; i < count; i++) {
        await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
        pending.shift()!();
        await tick();
      }
    },
  };
}

describe("fusion.delegate call-wide concurrency", () => {
  it.each([
    ["one role", [build, { ...build, id: "b2" }, { ...build, id: "b3" }]],
    ["main, roles and orchestrator", [main, build, review, strong]],
  ] as const)("maxWorkers 1 serializes %s", async (_label, tasks) => {
    const h = harness();
    const running = h.start([...tasks], 1);
    await vi.waitFor(() => expect(h.started.length).toBeGreaterThan(0));
    await tick();
    expect(h.active).toBe(1);
    await h.drain(tasks.length);
    const result = await running;
    expect(h.peak).toBe(1);
    expect(result.details.maxWorkers).toBe(1);
    expect((result.details.tasks as WorkerTaskResult[]).map((r) => r.id)).toEqual(tasks.map((t) => t.id));
  });

  it("shares width 2 fairly between main and role pools", async () => {
    const h = harness();
    const tasks = [main, { ...main, id: "main2" }, build, review, strong];
    const running = h.start(tasks, 2);
    await vi.waitFor(() => expect(h.started.length).toBeGreaterThanOrEqual(2));
    await tick();
    expect(h.active).toBe(2);
    h.pending.shift()!();
    await vi.waitFor(() => expect(h.started.length).toBeGreaterThanOrEqual(3));
    expect(h.started[2]).toBe("build");
    await h.drain(tasks.length - 1);
    expect((await running).details.maxWorkers).toBe(2);
    expect(h.peak).toBe(2);
  });

  it("does not apply an unused main local pool to cloud role-only tasks", async () => {
    const h = harness({ workerSupportsSlotAffinity: (p) => p === "main", slotManager: { poolSize: () => 1 } });
    const tasks = Array.from({ length: 4 }, (_, i) => ({ ...build, id: `b${i}` }));
    const running = h.start(tasks, 4);
    await vi.waitFor(() => expect(h.active).toBe(4));
    await h.drain(tasks.length);
    expect((await running).details.maxWorkers).toBe(4);
    expect(h.peak).toBe(4);
  });

  it("an unnamed width on an unpinned local main leg does not serialize cloud role tasks", async () => {
    const h = harness({ workerSupportsSlotAffinity: (p) => p === "main", slotManager: { poolSize: () => 2 } }, mode({ workersPinned: false }));
    const tasks = Array.from({ length: 4 }, (_, i) => ({ ...build, id: `b${i}` }));
    const running = h.start(tasks, undefined);
    await vi.waitFor(() => expect(h.active).toBe(4));
    await h.drain(tasks.length);
    expect((await running).details.maxWorkers).toBe(4);
    expect(h.peak).toBe(4);
  });

  it("an unnamed width keeps the local main default of one beside cloud role width", async () => {
    const h = harness({ workerSupportsSlotAffinity: (p) => p === "main", slotManager: { poolSize: () => 4 } }, mode({ workersPinned: false }));
    const tasks = [main, { ...main, id: "main2" }, build, { ...build, id: "build2" }, review];
    const running = h.start(tasks, undefined);
    await vi.waitFor(() => expect(h.active).toBe(4));
    await tick();
    expect(h.active).toBe(4);
    await h.drain(tasks.length);
    expect((await running).details.maxWorkers).toBe(4);
    expect(h.peaks.get("main")).toBe(1);
    expect(h.peaks.get("builder")).toBe(2);
    expect(h.peaks.get("reviewer")).toBe(1);
  });

  it("an unnamed width runs one local worker at a time across the main and local role legs", async () => {
    const local = new Set(["main", "builder"]);
    const h = harness({ workerSupportsSlotAffinity: (p) => local.has(p), slotManager: { poolSize: () => 4 } },
      mode({ workersPinned: false, roles: { byRole: { build: { ...role("builder"), local: true }, review: role("reviewer") }, mixLocalModels: true, localLegProviderIds: ["builder"] } }));
    const tasks = [main, { ...main, id: "main2" }, build, { ...build, id: "build2" }, review];
    const running = h.start(tasks, undefined);
    await vi.waitFor(() => expect(h.active).toBe(2));
    await tick();
    // The GPU's one worker plus the cloud reviewer.
    expect(h.active).toBe(2);
    expect(h.started).toContain("review");
    await h.drain(tasks.length);
    expect((await running).details.maxWorkers).toBe(2);
    expect(h.localPeak(local)).toBe(1);
  });

  it("an unnamed width on a cloud main leg applies workers to that leg only", async () => {
    const h = harness({}, mode({ workers: 1, workersPinned: false }));
    const tasks = [main, { ...main, id: "main2" }, build, { ...build, id: "build2" }];
    const running = h.start(tasks, undefined);
    await vi.waitFor(() => expect(h.active).toBe(3));
    await tick();
    expect(h.active).toBe(3);
    await h.drain(tasks.length);
    expect((await running).details.maxWorkers).toBe(3);
    expect(h.peaks.get("main")).toBe(1);
    expect(h.peaks.get("builder")).toBe(2);
  });

  it("names a binding local main pool even when role legs are active", async () => {
    const h = harness({ workerSupportsSlotAffinity: (p) => p === "main", slotManager: { poolSize: () => 1 } });
    const tasks = [main, { ...main, id: "main2" }, { ...main, id: "main3" }, build];
    const running = h.start(tasks, 4);
    await h.drain(tasks.length);
    const result = await running;
    expect(result.details.maxWorkers).toBe(2);
    expect(result.summary).toContain("3 workers' worth of work was sent");
    expect(result.summary).toContain("1 request slot,");
    expect(result.summary).toContain("only 1 ran at a time");
  });

  it("names a binding cloud cap on the main leg beside role legs, and stays quiet when it is not binding", async () => {
    const h = harness({}, mode({ cloudWorkers: 2 }));
    const tasks = [main, { ...main, id: "main2" }, { ...main, id: "main3" }, build];
    const running = h.start(tasks, 4);
    await h.drain(tasks.length);
    expect((await running).summary).toContain("the cloud worker cap (`llm.runMode.fusion.cloudWorkers`)");
    const quiet = harness({ workerSupportsSlotAffinity: (p) => p === "main", slotManager: { poolSize: () => 4 } }, mode({ workersPinned: false }));
    const calm = quiet.start([main, { ...main, id: "main2" }, build], undefined);
    await quiet.drain(3);
    const calmResult = await calm;
    expect(calmResult.summary).not.toContain("request slot");
    expect(calmResult.summary).not.toContain("was clamped");
  });

  it("names the default width, not maxWorkers, when the cloud cap clamps a call that named none", async () => {
    const h = harness({}, mode({ workers: 4, workersPinned: false, cloudWorkers: 2 }));
    const tasks = [main, { ...main, id: "main2" }, { ...main, id: "main3" }];
    const running = h.start(tasks, undefined);
    await h.drain(tasks.length);
    const summary = (await running).summary;
    expect(summary).toContain("the default width of 3 (`llm.runMode.fusion.workers`; this call named no maxWorkers) was clamped to 2, the cloud worker cap (`llm.runMode.fusion.cloudWorkers`)");
    expect(summary).not.toContain("maxWorkers 3");
  });

  it("keeps physical, cloud and strong leg caps within the call ceiling", async () => {
    const h = harness({ workerSupportsSlotAffinity: (p) => p === "main", slotManager: { poolSize: () => 1 } }, mode({ cloudWorkers: 2 }));
    const tasks = [main, { ...main, id: "main2" }, build, { ...build, id: "build2" }, { ...build, id: "build3" }, strong, { ...strong, id: "strong2" }, { ...strong, id: "strong3" }];
    const running = h.start(tasks, 8);
    await vi.waitFor(() => expect(h.active).toBeGreaterThanOrEqual(5));
    await tick();
    expect(h.active).toBe(5);
    await h.drain(tasks.length);
    expect((await running).details.maxWorkers).toBe(5);
    expect(h.peaks.get("main")).toBe(1);
    expect(h.peaks.get("builder")).toBe(2);
    expect(h.peaks.get("strong")).toBe(2);
  });

  it("aborts queued tasks without minting sessions or calling runTurn", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const controller = new AbortController();
    const h = harness();
    const running = h.start([main, build, review, strong], 1, controller.signal);
    await vi.waitFor(() => expect(h.started.length).toBeGreaterThan(0));
    await tick();
    now += 10_000;
    controller.abort();
    const result = await running;
    expect(h.started).toEqual(["main"]);
    expect(h.minted).toBe(1);
    expect(h.active).toBe(0);
    expect((result.details.tasks as WorkerTaskResult[]).every((r) => r.status === "cancelled")).toBe(true);
    expect((result.details.tasks as WorkerTaskResult[]).find((r) => r.id === "build")?.schedulerQueueWaitMs).toBe(10_000);
  });

  it("rechecks a turn budget after queued admission before creating a session", async () => {
    const budget = new FusionTurnBudget();
    const h = harness({ turnBudget: budget }, mode({ turnBudgetUsd: 0.5 }));
    const running = h.start([main, build, review], 1);
    await vi.waitFor(() => expect(h.started).toEqual(["main"]));
    await tick();
    budget.addWorkerSpend("parent", 1);
    await h.drain(1);
    const result = await running;
    expect(h.started).toEqual(["main"]);
    expect(h.minted).toBe(1);
    const rows = result.details.tasks as WorkerTaskResult[];
    expect(rows.slice(1).every((r) => r.status === "cancelled" && r.error?.startsWith("not started:"))).toBe(true);
  });

  it("releases its permit after a session factory throws", async () => {
    let first = true;
    const h = harness({ createEphemeralSession: (meta) => {
      if (first) { first = false; throw new Error("session creation failed"); }
      return createEmptySessionState({ id: `worker-${meta.taskId}`, workingDir: dir, metadata: { fusionWorker: meta } });
    } });
    const running = h.start([main, build], 1);
    // Attach rejection handling immediately: a regression must fail an assertion.
    const settled = running.catch((err: unknown) => err);
    await vi.waitFor(() => expect(h.started).toEqual(["build"]));
    await h.drain(1);
    const result = await settled;
    expect(result).toHaveProperty("details.tasks");
    const rows = (result as Awaited<typeof running>).details.tasks as WorkerTaskResult[];
    expect(rows[0]).toMatchObject({ status: "failed", error: "session creation failed" });
    expect(rows[1]).toMatchObject({ status: "ok" });
  });

  it("independent calls each own their width", async () => {
    const h = harness();
    const one = h.start([main, build], 1, undefined, "one");
    const two = h.start([{ ...main, id: "second" }, review], 1, undefined, "two");
    await vi.waitFor(() => expect(h.active).toBeGreaterThanOrEqual(2));
    await tick();
    expect(h.active).toBe(2);
    await h.drain(4);
    expect((await one).details.maxWorkers).toBe(1);
    expect((await two).details.maxWorkers).toBe(1);
    expect(h.peak).toBe(2);
  });

  it("starts the task clock after scheduler queueing and reports that wait separately", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const h = harness();
    const running = h.start([main, build], 1);
    await vi.waitFor(() => expect(h.started).toEqual(["main"]));
    await tick();
    now += 90_000; // Longer than this fixture's 60-second task budget.
    h.pending.shift()!();
    await vi.waitFor(() => expect(h.started).toEqual(["main", "build"]));
    await h.drain(1);
    const result = await running;
    const rows = result.details.tasks as WorkerTaskResult[];
    expect(rows[1]).toMatchObject({ status: "ok", durationMs: 0, schedulerQueueWaitMs: 90_000 });
    expect(rows[1]!.queueWaitMs).toBeNull();
    // One call-wide line, not a note on every queued row.
    expect(rows[1]!.notes?.join(" ") ?? "").not.toContain("worker slot");
    expect(result.summary).toContain("1 task waited up to 2 min for a worker slot");
  });

  it("aggregates every queued task's wait into one call-wide note", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const h = harness();
    const tasks = [main, build, review, strong];
    const running = h.start(tasks, 1);
    for (const wait of [10_000, 20_000, 30_000, 0]) {
      await vi.waitFor(() => expect(h.pending.length).toBe(1));
      now += wait;
      h.pending.shift()!();
      await tick();
    }
    const result = await running;
    const rows = result.details.tasks as WorkerTaskResult[];
    expect(rows.map((r) => r.schedulerQueueWaitMs ?? 0).sort((a, b) => a - b)).toEqual([0, 10_000, 30_000, 60_000]);
    expect(rows.every((r) => !(r.notes ?? []).join(" ").includes("worker slot"))).toBe(true);
    expect(result.summary.match(/waited up to/g)).toHaveLength(1);
    expect(result.summary).toContain("3 tasks waited up to 1 min for a worker slot");
  });
});
