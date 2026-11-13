import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";
import { dependencyWarnings } from "./contract-waves.js";
import type { WorkerTaskResult, WorkerTaskStatus } from "./worker-result.js";
import { FusionTurnBudget } from "./turn-budget.js";

const logger = new StructuredLogger({ level: "error", sinks: [] });
const tasks = [
  { id: "core", instructions: "provide core" },
  { id: "ui", instructions: "use core" },
  { id: "page", instructions: "use ui" },
];
const contract = {
  provides: [{ task: "core", kind: "file", name: "core.js" }, { task: "ui", kind: "file", name: "ui.js" }],
  requires: [{ task: "ui", name: "core.js" }, { task: "page", name: "ui.js" }],
};

describe("dependency readiness before a later worker starts", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fusion-ready-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function fixture(autoReplan: number, core: "reply" | "max_steps" | "failed" = "reply", over: Partial<FusionDelegateDeps> = {}, modeOver: Partial<ResolvedRunMode> = {}) {
    const ran: string[] = [];
    let minted = 0;
    const deps: FusionDelegateDeps = {
      runTurn: async (session, _brief, options) => {
        const id = (session.metadata as { fusionWorker: { taskId: string } }).fusionWorker.taskId;
        ran.push(id);
        if (id === "core" && existsSync(join(dir, "core.js"))) {
          options.eventHook?.({ type: "llm_event", event: { type: "tool_call_executed", result: { tool: "os.fs.write", status: "ok", summary: "written", details: { path: join(dir, "core.js"), existed: true, addedLines: 1, removedLines: 0 }, truncated: false }, batchIndex: 0, batchSize: 1 } });
        }
        return { session, reason: id === "core" ? core : "reply", stepCount: 1 };
      },
      createEphemeralSession: (meta, workingDir) => createEmptySessionState({ id: `fusion-worker-${++minted}`, workingDir: workingDir ?? dir, metadata: { fusionWorker: { ...meta } } }),
      approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {}, fanoutScopes: new FanoutScopeRegistry() },
      approvalRequired: false, emitEvent: () => {}, workingDir: dir, slotManager: { poolSize: () => 4 },
      resolveRunMode: () => ({ stored: "fusion", effective: "fusion", orchestratorProviderId: "cloud", orchestratorModel: "big", workerProviderId: "worker", workerModel: "small", workers: 1, workersPinned: true, workerMaxSteps: 7, workerTimeoutMs: 60_000, primaryProviderId: "cloud", degraded: null, autoReplan, ...modeOver } as ResolvedRunMode),
      workerSupportsSlotAffinity: () => false, warmWorkerBackend: async () => {}, outputCharCap: 4000, logger, ...over,
    };
    const run = (args: Record<string, unknown> = { tasks, contract }) => buildFusionDelegateTool(deps).run(args, { workingDir: dir, sessionId: "s-parent", stepIndex: 0, signal: new AbortController().signal });
    return { ran, run };
  }

  it.each([0, 2])("holds a transitive chain after max_steps with autoReplan=%i", async autoReplan => {
    const f = fixture(autoReplan, "max_steps");
    const result = await f.run();
    expect(f.ran).toEqual(["core"]);
    expect((result.details.tasks as WorkerTaskResult[]).map(r => r.status)).toEqual(["max_steps", "cancelled", "cancelled"]);
    if (autoReplan === 0) expect(result.details.replan).toBeUndefined();
    else expect((result.details.replan as { pending: { id: string }[] }).pending.map(r => r.id)).toEqual(["core", "ui", "page"]);
  });

  it.each(["failed", "max_steps", "timeout", "queued", "cancelled", "needs_orchestrator", "no_changes"] satisfies WorkerTaskStatus[])("warns about an incomplete %s provider", status => {
    expect(dependencyWarnings(["ui"], new Map([["ui", ["core"]]]), new Map([["core", { id: "core", status } as WorkerTaskResult]]))).toEqual([`task ui depends on core, which ended ${status}`]);
  });

  it("holds consumers when an ok provider's required file is absent", async () => {
    const f = fixture(0);
    const result = await f.run();
    expect(f.ran).toEqual(["core"]);
    expect((result.details.tasks as WorkerTaskResult[])[0]!.status).toBe("failed");
  });

  it("holds a matched provide with no inspectable artifact", async () => {
    const f = fixture(0);
    const result = await f.run({ tasks: tasks.slice(0, 2), contract: { provides: [{ task: "core", kind: "symbol", name: "ready" }], requires: [{ task: "ui", name: "ready" }] } });
    expect(f.ran).toEqual(["core"]);
    expect((result.details.tasks as WorkerTaskResult[])[0]!.error).toContain("cannot be verified");
  });

  it("preserves pathless other completion tokens as advisory ordering with a warning", async () => {
    const f = fixture(0);
    const result = await f.run({ tasks: tasks.slice(0, 2), contract: { provides: [{ task: "core", kind: "other", name: "ready" }], requires: [{ task: "ui", name: "ready" }] } });
    expect(f.ran).toEqual(["core", "ui"]);
    expect((result.details.tasks as WorkerTaskResult[]).map(r => r.status)).toEqual(["ok", "ok"]);
    expect((result.details.contract as { warnings: string[] }).warnings).toContain('provides "ready" (task core) cannot be checked: no `in`, no owned path, no declared files');
    expect((result.details.tasks as WorkerTaskResult[])[1]!.artifactManifest?.dependencies).toContainEqual({ provider: "core", requirementIndex: 0, status: "unknown" });
  });

  it("releases a complete chain whose required files are present", async () => {
    writeFileSync(join(dir, "core.js"), "export const core = 1;");
    writeFileSync(join(dir, "ui.js"), "export const ui = 1;");
    const f = fixture(0);
    await f.run();
    expect(f.ran).toEqual(["core", "ui", "page"]);
  });

  it("checks a provider's syntax before its consumer starts", async () => {
    writeFileSync(join(dir, "core.js"), "export const = ;");
    const events: string[] = [];
    const f = fixture(0, "reply", {
      syntaxCheck: async files => {
        events.push("syntax");
        return { results: files.map(file => ({ file, ok: false, checker: "javascript", error: "invalid syntax" })) };
      },
    });
    const result = await f.run({ tasks: [{ ...tasks[0]!, files: ["core.js"] }, tasks[1]!], contract: { provides: contract.provides.slice(0, 1), requires: contract.requires.slice(0, 1) } });
    expect(events.length).toBeGreaterThan(0);
    expect(f.ran).toEqual(["core"]);
    expect((result.details.tasks as WorkerTaskResult[])[0]!.status).toBe("failed");
  });

  it("holds cyclic dependencies while still running unrelated work", async () => {
    const f = fixture(0);
    const result = await f.run({ tasks: [...tasks.slice(0, 2), { id: "independent", instructions: "read something" }], contract: { provides: contract.provides, requires: [{ task: "ui", name: "core.js" }, { task: "core", name: "ui.js" }] } });
    expect(f.ran).toEqual(["independent"]);
    expect((result.details.tasks as WorkerTaskResult[]).slice(0, 2).every(r => r.status === "cancelled")).toBe(true);
    expect(result.summary).toContain("cycle");
  });

  it("checks required artifacts omitted from a fresh isolation syntax gate", async () => {
    writeFileSync(join(dir, "core.js"), "Core.run = (");
    writeFileSync(join(dir, "aux.js"), "export const aux = 1;");
    const started: string[] = [];
    const checked: string[] = [];
    const f = fixture(0, "reply", {
      runTurn: async (session, _brief, options) => {
        const id = (session.metadata as { fusionWorker: { taskId: string } }).fusionWorker.taskId;
        started.push(id);
        if (id === "core") {
          const path = join(session.workingDir, "aux.js");
          writeFileSync(path, "export const aux = 2;");
          options.eventHook?.({ type: "llm_event", event: { type: "tool_call_executed", result: { tool: "os.fs.write", status: "ok", summary: "written", details: { path, existed: true, addedLines: 1, removedLines: 1 }, truncated: false }, batchIndex: 0, batchSize: 1 } });
        }
        return { session, reason: "reply", stepCount: 1 };
      },
      syntaxCheck: async files => {
        checked.push(...files.map(file => basename(file)));
        return { results: files.map(file => ({ file, ok: basename(file) !== "core.js", checker: "javascript", ...(basename(file) === "core.js" ? { error: "invalid syntax" } : {}) })) };
      },
    }, { isolation: "worktree" });
    const result = await f.run({ tasks: [{ ...tasks[0]!, files: ["aux.js"] }, tasks[1]!], contract: { provides: [{ task: "core", kind: "symbol", name: "Core.run", in: "core.js" }], requires: [{ task: "ui", name: "Core.run" }] } });
    expect(checked).toContain("core.js");
    expect(started).toEqual(["core"]);
    expect((result.details.tasks as WorkerTaskResult[]).map(r => r.status)).toEqual(["failed", "cancelled"]);
  });

  it.each([
    { isolation: "off" as const, failure: "missing" },
    { isolation: "worktree" as const, failure: "missing" },
    { isolation: "off" as const, failure: "check" },
    { isolation: "worktree" as const, failure: "check" },
  ])("revalidates a provider after an intermediate wave changes $failure with isolation=$isolation", async ({ isolation, failure }) => {
    writeFileSync(join(dir, "core.js"), "export const core = 1;");
    writeFileSync(join(dir, "ui.js"), "export const ui = 1;");
    writeFileSync(join(dir, "semantic.flag"), "good");
    const started: string[] = [];
    const f = fixture(0, "reply", {
      runTurn: async (session) => {
        const id = (session.metadata as { fusionWorker: { taskId: string } }).fusionWorker.taskId;
        started.push(id);
        if (id === "ui") {
          // A shell can change undeclared inputs without file-tool events.
          if (failure === "missing") unlinkSync(join(session.workingDir, "core.js"));
          else writeFileSync(join(session.workingDir, "semantic.flag"), "bad");
          writeFileSync(join(session.workingDir, "ui.js"), "export const ui = 2;");
        }
        return { session, reason: "reply", stepCount: 1 };
      },
      syntaxCheck: async files => ({ results: files.map(file => ({ file, ok: true, checker: "javascript" })) }),
      runChecks: async (specs, ctx) => ({ ok: true, results: specs.map(() => ({ ok: readFileSync(join(ctx.workingDir, "semantic.flag"), "utf8") === "good", error: "semantic flag changed" })) }),
    }, isolation === "worktree" ? { isolation } : {});
    const result = await f.run({ tasks, contract: {
      ...contract,
      requires: [...contract.requires, { task: "page", name: "core.js" }],
      ...(failure === "check" ? { checks: [{ task: "core", kind: "command", cmd: "check-core" }] } : {}),
    } });
    expect(started).toEqual(["core", "ui"]);
    expect((result.details.tasks as WorkerTaskResult[]).map(r => r.status)).toEqual(["failed", "ok", "cancelled"]);
  });

  it("propagates a turn-budget abort into provider verification", async () => {
    writeFileSync(join(dir, "core.js"), "export const core = 1;");
    const budget = new FusionTurnBudget();
    budget.begin("s-parent");
    let calls = 0;
    let verificationSignal: AbortSignal | undefined;
    const f = fixture(0, "reply", {
      turnBudget: budget,
      runChecks: async (specs, ctx) => {
        if (++calls === 2) {
          verificationSignal = ctx.signal;
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, 600);
            ctx.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
          });
        }
        return { ok: true, results: specs.map(() => ({ ok: true })) };
      },
    }, { turnTimeBudgetMs: 250 });
    await f.run({ tasks: tasks.slice(0, 2), contract: { provides: contract.provides.slice(0, 1), requires: contract.requires.slice(0, 1), checks: [{ task: "core", kind: "command", cmd: "check-core" }] } });
    expect(verificationSignal).toBeDefined();
    expect(verificationSignal!.aborted).toBe(true);
  });
});
