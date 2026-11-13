import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    expect(row).toMatchObject({ status: "ok", reply: "Now out.txt is written", stepCount: 6 });
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
