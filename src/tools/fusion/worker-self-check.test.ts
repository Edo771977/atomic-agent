import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunTurnResult } from "../../agent/agent-loop.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { SessionState } from "../../session/session-state.js";
import {
  FUSION_WORKER_ID_PREFIX,
  type FusionWorkerMeta,
} from "../../session/fusion-worker-session.js";
import type { ContractCheckRunner } from "./contract-checks.js";
import type { DelegateContract } from "./contract.js";
import type { DelegateTask } from "./delegate-args.js";
import { runWorkerTasks, type WorkerRunnerDeps } from "./worker-runner.js";
import {
  SELF_CHECK_GRACE_STEPS,
  concurrentPaths,
  mentionsPath,
  runSelfCheck,
} from "./worker-self-check.js";

/**
 * A worker checks its own work before its reply closes the task: a
 * missing declared file or a failing own check gets ONE notice and a
 * few more steps, with local tokens, instead of a round of the
 * orchestrator's.
 */

type Call = {
  session: SessionState;
  message: string;
  options: Parameters<WorkerRunnerDeps["runTurn"]>[2];
};

const BASE = {
  parentSessionId: "s-parent",
  providerId: "local",
  workerModel: "small",
  workerMaxSteps: 20,
  workerTimeoutMs: 600_000,
  maxWorkers: 1,
};

function harness(
  dir: string,
  turn: (call: Call, index: number) => Promise<Partial<RunTurnResult>> | Partial<RunTurnResult>,
  runChecks?: ContractCheckRunner,
): { deps: WorkerRunnerDeps; calls: Call[] } {
  const calls: Call[] = [];
  let minted = 0;
  const deps: WorkerRunnerDeps = {
    runTurn: async (session, message, options) => {
      const call = { session, message, options };
      calls.push(call);
      const over = await turn(call, calls.length - 1);
      return { session, reason: "reply", stepCount: 3, ...over } as RunTurnResult;
    },
    createEphemeralSession: (meta: FusionWorkerMeta) => {
      minted += 1;
      return createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
        workingDir: dir,
        metadata: { fusionWorker: { ...meta } },
      });
    },
    approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {} },
    emitEvent: () => {},
    workingDir: dir,
    ...(runChecks === undefined ? {} : { runChecks }),
  };
  return { deps, calls };
}

function say(call: Call, text: string): void {
  call.options.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text } });
}

/** One finished step of the worker's that ran `tool` with `args`. */
function step(call: Call, tool: string, args: Record<string, unknown>, status: "ok" | "error" = "ok"): void {
  const hook = call.options.eventHook!;
  hook({ type: "llm_event", event: { type: "tool_call_parsed", call: { tool, args }, batchIndex: 0, batchSize: 1 } });
  hook({
    type: "llm_event",
    event: {
      type: "tool_call_executed",
      result: { tool, status, summary: `${tool} ${status}`, details: {}, truncated: false },
      batchIndex: 0,
      batchSize: 1,
    },
  });
  hook({ type: "step_finished" } as never);
}

const OWN_SPEC = { kind: "command", args: ["score.test.js"], cmd: "node" };

/** One completion with `tokens` prompt and completion tokens each. */
function complete(call: Call, tokens: number): void {
  call.options.eventHook?.({
    type: "llm_event",
    event: {
      type: "llm_completed",
      completion: { content: "", usage: { promptTokens: tokens, completionTokens: tokens } },
    },
  } as never);
}

const CHECKED: DelegateContract = {
  checks: [
    { task: "t", kind: "command", cmd: "node", args: ["score.test.js"] },
    { task: "other", kind: "command", cmd: "node", args: ["other.js"] },
    { kind: "command", cmd: "npm", args: ["test"] },
  ],
};

const FAILING = {
  ok: false,
  summary: "verify.run command: FAILED\nexit 1 after 40 ms\nstderr (tail):\nAssertionError: expected 3 to equal 4\n    at score.test.js:12:5",
  stderrTail: "AssertionError: expected 3 to equal 4\n    at score.test.js:12:5",
};

describe("a worker's self-check before its reply closes the task", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-self-check-"));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("tells a worker that replied over a missing declared file, once, and lets it write it", async () => {
    const { deps, calls } = harness(dir, (call, i) => {
      if (i === 1) writeFileSync(join(dir, "out.txt"), "the result");
      say(call, i === 0 ? "Wrote out.txt" : "Now out.txt is written");
      return {};
    });
    const task: DelegateTask = { id: "t", title: "T", instructions: "write out.txt", files: ["out.txt"] };
    const [row] = await runWorkerTasks(deps, { ...BASE, tasks: [task], signal: new AbortController().signal });
    expect(calls).toHaveLength(2);
    // The same conversation, its next message, with a small step grace.
    expect(calls[1]!.session.id).toBe(calls[0]!.session.id);
    expect(calls[1]!.message).toContain("Your reply did not close the task");
    expect(calls[1]!.message).toContain("- declared file out.txt does not exist");
    expect(calls[1]!.options.maxSteps).toBe(SELF_CHECK_GRACE_STEPS);
    expect(row).toMatchObject({ status: "ok", reply: "Now out.txt is written", stepCount: 6, selfCheckNotice: true });
    expect(row!.notes).toContain(
      "self-check: its first reply left declared file out.txt missing; it was told once and given 4 more steps",
    );
  });

  it("runs only the task's own checks in its workspace and gives a failing one's output back with a second chance", async () => {
    let fixed = false;
    const runChecks = vi.fn<ContractCheckRunner>(async (specs) => ({
      ok: fixed,
      results: specs.map(() => (fixed ? { ok: true, summary: "verify.run command: ok" } : FAILING)),
    }));
    const { deps, calls } = harness(
      dir,
      (call, i) => {
        if (i === 1) fixed = true;
        say(call, "done");
        return {};
      },
      runChecks,
    );
    const task: DelegateTask = { id: "t", title: "T", instructions: "make the score test pass" };
    const [row] = await runWorkerTasks(deps, {
      ...BASE,
      tasks: [task],
      contract: CHECKED,
      signal: new AbortController().signal,
    });
    expect(runChecks).toHaveBeenCalledTimes(1);
    expect(runChecks.mock.calls[0]![0]).toEqual([{ kind: "command", cmd: "node", args: ["score.test.js"] }]);
    expect(runChecks.mock.calls[0]![1].workingDir).toBe(dir);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.message).toContain(
      '- your check {"kind":"command","cmd":"node","args":["score.test.js"]} failed: verify.run command: FAILED exit 1 after 40 ms',
    );
    expect(calls[1]!.message).toContain("    AssertionError: expected 3 to equal 4\n        at score.test.js:12:5");
    expect(calls[1]!.message).toContain("Re-run the failing check with verify.run");
    expect(row!.status).toBe("ok");
    expect(row!.notes).toContain(
      "self-check: its first reply left its own check failing; it was told once and given 4 more steps",
    );
  });

  it("tells it once only: a worker that still has not fixed it ends as before", async () => {
    const runChecks = vi.fn<ContractCheckRunner>(async (specs) => ({ ok: false, results: specs.map(() => FAILING) }));
    const { deps, calls } = harness(dir, (call) => {
      say(call, "done");
      return {};
    }, runChecks);
    const task: DelegateTask = { id: "t", title: "T", instructions: "x", files: ["missing.txt"] };
    const [row] = await runWorkerTasks(deps, {
      ...BASE,
      tasks: [task],
      contract: CHECKED,
      signal: new AbortController().signal,
    });
    expect(calls).toHaveLength(2);
    expect(runChecks).toHaveBeenCalledTimes(1);
    // One notice names both: the absence and the check.
    expect(calls[1]!.message).toContain("- declared file missing.txt does not exist");
    expect(calls[1]!.message).toContain("- your check");
    expect(row).toMatchObject({
      status: "failed",
      error: "declared file missing.txt does not exist after the task",
    });
    expect(existsSync(join(dir, "missing.txt"))).toBe(false);
  });

  it("changes nothing for a task without declared files or checks of its own", async () => {
    const runChecks = vi.fn<ContractCheckRunner>();
    const { deps, calls } = harness(dir, (call) => {
      say(call, "the answer");
      return {};
    }, runChecks);
    const [row] = await runWorkerTasks(deps, {
      ...BASE,
      tasks: [{ id: "research", title: "R", instructions: "look into it" }],
      contract: CHECKED,
      signal: new AbortController().signal,
    });
    expect(calls).toHaveLength(1);
    expect(runChecks).not.toHaveBeenCalled();
    expect(row!.status).toBe("ok");
    expect(row!.notes ?? []).not.toContainEqual(expect.stringMatching(/self-check/));
  });

  it("does not check a worker that did not reply, or that has too few steps left for a grace", async () => {
    const { deps, calls } = harness(dir, (call, i) => {
      say(call, "partial");
      // 19 of 20 steps used: no room for a grace that could fix anything.
      return i === 0 ? { stepCount: 19 } : {};
    });
    const task: DelegateTask = { id: "t", title: "T", instructions: "x", files: ["out.txt"] };
    await runWorkerTasks(deps, { ...BASE, tasks: [task], signal: new AbortController().signal });
    expect(calls).toHaveLength(1);

    const cancelled = harness(dir, () => ({ reason: "cancelled" }));
    await runWorkerTasks(cancelled.deps, { ...BASE, tasks: [task], signal: new AbortController().signal });
    expect(cancelled.calls).toHaveLength(1);
  });

  it("holds the worker no longer than its time cap when a check hangs, and then gives no notice", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const never: ContractCheckRunner = () => new Promise(() => {});
    const { deps, calls } = harness(dir, (call) => {
      say(call, "done");
      return {};
    }, never);
    const run = runWorkerTasks(deps, {
      ...BASE,
      tasks: [{ id: "t", title: "T", instructions: "x" }],
      contract: CHECKED,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(120_001);
    const [row] = await run;
    expect(calls).toHaveLength(1);
    expect(row!.status).toBe("ok");
    // The orchestrator learns the self-check gave nothing.
    expect(row!.notes).toContain(
      "self-check: its own checks did not finish within 120s, so it was told nothing; only the post-fan-out run judges them",
    );
  });

  it("masks secrets in a failing check's output before the notice reaches the worker", async () => {
    const leaky = {
      ok: false,
      summary: "verify.run command: FAILED\nexit 1 after 40 ms",
      stderrTail:
        "Error: connect ECONNREFUSED DATABASE_URL=postgres://app:hunter2-pw-9@db:5432/app\n" +
        "using token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and key custom-known-value-77",
    };
    const runChecks = vi.fn<ContractCheckRunner>(async (specs) => ({
      ok: false,
      results: specs.map(() => leaky),
    }));
    const { deps, calls } = harness(dir, (call) => {
      say(call, "done");
      return {};
    }, runChecks);
    deps.knownSecrets = () => [{ label: "MY_API_KEY", value: "custom-known-value-77" }];
    await runWorkerTasks(deps, {
      ...BASE,
      tasks: [{ id: "t", title: "T", instructions: "x" }],
      contract: CHECKED,
      signal: new AbortController().signal,
    });
    expect(calls).toHaveLength(2);
    const notice = calls[1]!.message;
    expect(notice).toContain("- your check");
    expect(notice).not.toContain("hunter2-pw-9");
    expect(notice).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(notice).not.toContain("custom-known-value-77");
    expect(notice).toContain("postgres://app:[redacted:password]@db");
    expect(notice).toContain("[redacted:MY_API_KEY]");
  });

  describe("a check that needs a file a task running alongside writes", () => {
    const SIBLING: DelegateContract = {
      owners: { "a.js": "a", "b.js": "t" },
      checks: [
        { task: "t", kind: "command", cmd: "node", args: ["b.test.js", "./a.js"] },
        { task: "t", kind: "command", cmd: "node", args: ["b.test.js"] },
      ],
    };

    it("is not self-run when its spec names a path a concurrent task owns", async () => {
      const runChecks = vi.fn<ContractCheckRunner>(async (specs) => ({
        ok: false,
        results: specs.map(() => FAILING),
      }));
      const { deps, calls } = harness(dir, (call) => {
        say(call, "done");
        return {};
      }, runChecks);
      const [row] = await runWorkerTasks(deps, {
        ...BASE,
        maxWorkers: 2,
        tasks: [
          { id: "t", title: "T", instructions: "x" },
          { id: "a", title: "A", instructions: "y" },
        ],
        contract: SIBLING,
        signal: new AbortController().signal,
      });
      expect(runChecks).toHaveBeenCalledTimes(1);
      expect(runChecks.mock.calls[0]![0]).toEqual([{ kind: "command", cmd: "node", args: ["b.test.js"] }]);
      const notices = calls.filter((c) => c.message.startsWith("Your reply did not close the task"));
      expect(notices).toHaveLength(1);
      expect(notices[0]!.message).not.toContain("a.js");
      expect(row!.id).toBe("t");
    });

    it("gives no notice for a failure whose output names a concurrent task's path", async () => {
      const runChecks = vi.fn<ContractCheckRunner>(async (specs) => ({
        ok: false,
        results: specs.map(() => ({
          ok: false,
          summary: "verify.run command: FAILED\nexit 1 after 5 ms",
          stderrTail: "Error: Cannot find module '/work/a.js'\n    at b.test.js:1:1",
        })),
      }));
      const { deps, calls } = harness(dir, (call) => {
        say(call, "done");
        return {};
      }, runChecks);
      // Only `t` on this leg; `a` runs on another one in the same wave.
      const [row] = await runWorkerTasks(deps, {
        ...BASE,
        tasks: [{ id: "t", title: "T", instructions: "x" }],
        concurrentTaskIds: ["t", "a"],
        contract: { owners: SIBLING.owners!, checks: [SIBLING.checks![1]!] },
        signal: new AbortController().signal,
      });
      expect(runChecks).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(1);
      expect(row!.status).toBe("ok");
    });

    it("reads the concurrent tasks' paths from owners and provides, never this task's or the inputs", () => {
      const contract: DelegateContract = {
        inputs: ["data.csv"],
        owners: { "./a.js": "a", "lib/": "a", "b.js": "t", "data.csv": "a" },
        provides: [
          { task: "a", kind: "symbol", name: "A.run", in: "src/a-api.js" },
          { task: "a", kind: "file", name: "out/report.md" },
          { task: "later", kind: "file", name: "z.js" },
        ],
      };
      expect(concurrentPaths(contract, "t", ["t", "a"]).sort()).toEqual(
        ["a.js", "lib", "out/report.md", "src/a-api.js"].sort(),
      );
      expect(concurrentPaths(contract, "t", ["t"])).toEqual([]);
      expect(mentionsPath('{"args":["./a.js"]}', "a.js")).toBe(true);
      expect(mentionsPath("at /work/a.js:3:1", "a.js")).toBe(true);
      expect(mentionsPath("data.js and a.jsx and a.js.map", "a.js")).toBe(false);
    });

    it("still runs a check naming a path of a task that is not running alongside it", async () => {
      const runChecks = vi.fn<ContractCheckRunner>(async (specs) => ({
        ok: false,
        results: specs.map(() => FAILING),
      }));
      const { deps } = harness(dir, (call) => {
        say(call, "done");
        return {};
      }, runChecks);
      // `a` finished in an earlier wave: its file is there to read.
      await runWorkerTasks(deps, {
        ...BASE,
        tasks: [{ id: "t", title: "T", instructions: "x" }],
        contract: SIBLING,
        signal: new AbortController().signal,
      });
      expect(runChecks.mock.calls[0]![0]).toHaveLength(2);
    });
  });

  describe("a check the worker already ran", () => {
    const ONLY_OWN: DelegateContract = { checks: [CHECKED.checks![0]!] };
    const run = async (
      worker: (call: Call) => void,
    ): Promise<{ runChecks: ReturnType<typeof vi.fn<ContractCheckRunner>>; calls: Call[] }> => {
      const runChecks = vi.fn<ContractCheckRunner>(async (specs) => ({
        ok: false,
        results: specs.map(() => FAILING),
      }));
      const { deps, calls } = harness(dir, (call, i) => {
        if (i === 0) worker(call);
        say(call, "done");
        return {};
      }, runChecks);
      await runWorkerTasks(deps, {
        ...BASE,
        tasks: [{ id: "t", title: "T", instructions: "x" }],
        contract: ONLY_OWN,
        signal: new AbortController().signal,
      });
      return { runChecks, calls };
    };

    it("is not run again when its identical spec passed after the worker's last write", async () => {
      const { runChecks, calls } = await run((call) => {
        step(call, "os.fs.write", { path: "score.js", content: "x" });
        // Same spec, keys in another order.
        step(call, "verify.run", OWN_SPEC);
        step(call, "os.fs.read", { path: "score.js" });
      });
      expect(runChecks).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
    });

    it("is run again when the worker wrote after it passed, it failed, or the spec differs", async () => {
      const writeAfter = await run((call) => {
        step(call, "verify.run", OWN_SPEC);
        step(call, "os.fs.edit", { path: "score.js" });
      });
      expect(writeAfter.runChecks).toHaveBeenCalledTimes(1);
      const failed = await run((call) => step(call, "verify.run", OWN_SPEC, "error"));
      expect(failed.runChecks).toHaveBeenCalledTimes(1);
      const other = await run((call) => step(call, "verify.run", { ...OWN_SPEC, args: ["other.test.js"] }));
      expect(other.runChecks).toHaveBeenCalledTimes(1);
      const shell = await run((call) => {
        step(call, "verify.run", OWN_SPEC);
        step(call, "os.shell", { cmd: "sed -i s/a/b/ score.js" });
      });
      expect(shell.runChecks).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps a reply the grace wrote on its forced final step out of `ok`", async () => {
    const { deps, calls } = harness(dir, (call, i) => {
      say(call, i === 0 ? "Wrote out.txt" : "I could not finish writing out.txt");
      return i === 0 ? {} : { stopCause: "step_ceiling", stepCount: SELF_CHECK_GRACE_STEPS };
    });
    writeFileSync(join(dir, "out.txt"), "");
    const task: DelegateTask = { id: "t", title: "T", instructions: "x", files: ["out.txt", "more.txt"] };
    const [row] = await runWorkerTasks(deps, { ...BASE, tasks: [task], signal: new AbortController().signal });
    expect(calls).toHaveLength(2);
    // The declared-file check still turns it `failed`; what matters
    // here is that the forced reply was never upgraded to `ok`.
    expect(row!.status).not.toBe("ok");
    expect(row!.notes).toContainEqual(
      "self-check: the grace ran out of its 4 steps; the last reply was written on the forced final step",
    );

    // With nothing else wrong after it, the forced reply stays `max_steps`.
    const done = harness(dir, (call, i) => {
      if (i === 1) writeFileSync(join(dir, "late.txt"), "the result");
      say(call, "done");
      return i === 0 ? {} : { stopCause: "step_ceiling", stepCount: SELF_CHECK_GRACE_STEPS };
    });
    const [late] = await runWorkerTasks(done.deps, {
      ...BASE,
      tasks: [{ id: "t", title: "T", instructions: "x", files: ["late.txt"] }],
      signal: new AbortController().signal,
    });
    expect(done.calls).toHaveLength(2);
    expect(late!.status).toBe("max_steps");
    expect(late!.stepCount).toBe(3 + SELF_CHECK_GRACE_STEPS);
  });

  describe("when the worker's reply is not checked", () => {
    const task: DelegateTask = { id: "t", title: "T", instructions: "x", files: ["out.txt"] };

    it("skips a reply written on the first turn's forced final step", async () => {
      const { deps, calls } = harness(dir, (call) => {
        say(call, "ran out");
        return { stopCause: "step_ceiling" };
      });
      const [row] = await runWorkerTasks(deps, { ...BASE, tasks: [task], signal: new AbortController().signal });
      expect(calls).toHaveLength(1);
      expect(row!.status).not.toBe("ok");
    });

    it("skips a split proposal: its files are its children's", async () => {
      const { deps, calls } = harness(dir, (call) => {
        say(call, "Too big.\n```split_proposal\n{\"tasks\":[]}\n```");
        return {};
      });
      await runWorkerTasks(deps, {
        ...BASE,
        tasks: [task],
        canProposeSplit: () => true,
        signal: new AbortController().signal,
      });
      expect(calls).toHaveLength(1);
    });

    it("skips a worker with less than 10 s of its clock left", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const { deps, calls } = harness(dir, (call) => {
        // Served now, then most of the 600 s spent.
        complete(call, 10);
        vi.setSystemTime(Date.now() + 595_000);
        say(call, "done");
        return {};
      });
      await runWorkerTasks(deps, { ...BASE, tasks: [task], signal: new AbortController().signal });
      expect(calls).toHaveLength(1);
    });
  });

  it("asks the task's own workspace, not the working directory, under worktree isolation", async () => {
    const ws = join(dir, "ws-t");
    mkdirSync(ws);
    // Present in the task's workspace only: no finding.
    writeFileSync(join(ws, "out.txt"), "the result");
    const runChecks = vi.fn<ContractCheckRunner>(async (specs) => ({
      ok: true,
      results: specs.map(() => ({ ok: true, summary: "verify.run command: ok" })),
    }));
    const { deps, calls } = harness(dir, (call) => {
      say(call, "done");
      return {};
    }, runChecks);
    const [row] = await runWorkerTasks(deps, {
      ...BASE,
      tasks: [{ id: "t", title: "T", instructions: "x", files: ["out.txt"] }],
      contract: CHECKED,
      taskWorkspace: () => ({ workingDir: ws, writeScope: [ws] }),
      signal: new AbortController().signal,
    });
    expect(runChecks).toHaveBeenCalledTimes(1);
    expect(runChecks.mock.calls[0]![1].workingDir).toBe(ws);
    expect(calls).toHaveLength(1);
    expect(row!.status).toBe("ok");
  });

  it("runs the grace under the first turn's tool view, signals and hook, and counts both turns' spend", async () => {
    const controller = new AbortController();
    const usage: number[] = [];
    let graceSignal: AbortSignal | undefined;
    const { deps, calls } = harness(dir, (call, i) => {
      complete(call, i === 0 ? 100 : 7);
      if (i === 1) {
        graceSignal = call.options.signal;
        step(call, "os.fs.write", { path: "out.txt" });
        writeFileSync(join(dir, "out.txt"), "the result");
      }
      say(call, "done");
      return {};
    });
    const [row] = await runWorkerTasks(deps, {
      ...BASE,
      workerReasoning: "low",
      tasks: [{ id: "t", title: "T", instructions: "x", files: ["out.txt"] }],
      onWorkerUsage: (_id, u) => usage.push(u.completionTokens),
      signal: controller.signal,
    });
    expect(calls).toHaveLength(2);
    const [first, grace] = calls.map((c) => c.options);
    expect(grace!.toolFilter).toBe(first!.toolFilter);
    expect(grace!.toolRole).toBe(first!.toolRole);
    expect(grace!.origin).toBe(first!.origin);
    expect(grace!.providerId).toBe(first!.providerId);
    expect(grace!.reasoningEffort).toBe("low");
    expect(grace!.eventHook).toBeDefined();
    // The parent's signal reaches the grace turn.
    expect(graceSignal!.aborted).toBe(false);
    controller.abort();
    expect(graceSignal!.aborted).toBe(true);
    // The grace's events reach the same collector and the same spend.
    expect(usage).toEqual([100, 7]);
    expect(row!.usage).toMatchObject({ promptTokens: 107, completionTokens: 107 });
    expect(row!.tools.writes).toBe(1);
  });

  it("runSelfCheck reports a check run it cut at the cap as not run, never as failed", async () => {
    const out = await runSelfCheck({
      task: { id: "t", title: "T", instructions: "x" },
      contract: CHECKED,
      workingDir: dir,
      startedAt: Date.now(),
      runChecks: () => new Promise(() => {}),
      signal: new AbortController().signal,
      timeCapMs: 20,
    });
    expect(out.failed).toEqual([]);
    expect(out.checksNotRun).toMatch(/^not finished within/);
  });
});
