import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import {
  buildAcceptanceChecklist,
  gatherEvidence,
  JUDGE_DIFF_FILE_CHARS,
  JUDGE_FILE_CHARS,
  judgeTask,
  parseJudgeAnswer,
  renderRetryFindings,
  RETRY_OUTPUT_CHARS,
  type AcceptanceItem,
} from "./judge.js";
import {
  buildFusionDelegateTool,
  type FusionDelegateDeps,
} from "./fusion-delegate.js";
import type { EscalationComplete } from "./escalation.js";
import type { DelegateTask } from "./delegate-args.js";

const logger = new StructuredLogger({ level: "error", sinks: [] });
const TARGET = { providerId: "cloud", model: "judge-model" };

function answer(items: Array<{ id: string; pass: unknown; why?: string }>): EscalationComplete {
  return async () => ({ content: JSON.stringify({ items }) });
}

describe("acceptance checklist (ATO-944)", () => {
  it("lists the task's checks, provides, files, deliverable and instructions", () => {
    const task: DelegateTask = {
      id: "ui",
      title: "UI",
      instructions: "Build the HUD",
      deliverable: "a HUD showing score",
      files: ["hud.js"],
    };
    const items = buildAcceptanceChecklist(task, {
      checks: [{ task: "ui", command: "node test.js" }, { task: "other", command: "x" }],
      provides: [{ task: "ui", kind: "symbol", name: "HUD.draw", in: "hud.js", shape: "(ctx) => void" }],
    });
    expect(items.map((i) => i.kind)).toEqual([
      "check",
      "provide",
      "file",
      "deliverable",
      "instructions",
    ]);
    expect(items[0]!.checkIndex).toBe(0);
    expect(items[1]!.judged).toBe(true);
  });
});

describe("the judge cannot pass what the facts fail", () => {
  const dir = mkdtempSync(join(tmpdir(), "judge-"));
  const task: DelegateTask = { id: "t", title: "T", instructions: "write a.txt", files: ["a.txt"] };
  const items = buildAcceptanceChecklist(task, undefined);

  it("keeps a missing file red and does not pay the judge for it", async () => {
    let called = 0;
    const verdict = await judgeTask({
      task,
      items,
      facts: { checkOutcomes: [], findings: [] },
      reply: "Done! I wrote a.txt.",
      contract: undefined,
      workingDir: dir,
      target: TARGET,
      pricing: undefined,
      complete: async () => {
        called += 1;
        return { content: '{"items":[{"id":"a2","pass":true}]}' };
      },
      signal: new AbortController().signal,
    });
    expect(called).toBe(0);
    expect(verdict.green).toBe(false);
    expect(verdict.items.find((v) => v.id === "a1")).toMatchObject({ pass: false, why: "missing" });
  });

  it("reads only a literal true as a pass, and an item without a verdict as red", async () => {
    writeFileSync(join(dir, "a.txt"), "hello");
    const both: AcceptanceItem[] = [
      ...items,
      { id: "a3", kind: "deliverable", text: "x", judged: true },
    ];
    const verdict = await judgeTask({
      task,
      items: both,
      facts: { checkOutcomes: [], findings: [] },
      reply: "",
      contract: undefined,
      workingDir: dir,
      target: TARGET,
      pricing: undefined,
      complete: answer([{ id: "a2", pass: "yes" }]),
      signal: new AbortController().signal,
    });
    expect(verdict.green).toBe(false);
    expect(verdict.items.find((v) => v.id === "a2")?.pass).toBe(false);
    expect(verdict.items.find((v) => v.id === "a3")?.why).toBe("the judge gave no verdict");
  });

  it("leaves a task unverified, never green, when the answer cannot be read", async () => {
    const verdict = await judgeTask({
      task,
      items,
      facts: { checkOutcomes: [], findings: [] },
      reply: "",
      contract: undefined,
      workingDir: dir,
      target: TARGET,
      pricing: undefined,
      complete: async () => ({ content: "Looks great to me!" }),
      signal: new AbortController().signal,
    });
    expect(verdict.green).toBe(false);
    expect(verdict.unverified).toMatch(/could not be read/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses a JSON answer wrapped in prose", () => {
    const parsed = parseJudgeAnswer('Here: {"items":[{"id":"a1","pass":true,"why":"ok"}]} done');
    expect(parsed?.get("a1")).toEqual({ pass: true, why: "ok" });
  });
});

function mode(over: Partial<ResolvedRunMode> = {}): ResolvedRunMode {
  return {
    stored: "fusion",
    effective: "fusion",
    orchestratorProviderId: "cloud",
    orchestratorModel: "big",
    workerProviderId: "local",
    workerModel: "small",
    workers: 1,
    workersPinned: true,
    workerMaxSteps: 7,
    workerTimeoutMs: 60_000,
    primaryProviderId: "cloud",
    degraded: null,
    judge: TARGET,
    ...over,
  };
}

function deps(
  dir: string,
  complete: EscalationComplete,
  over: Partial<FusionDelegateDeps> = {},
): FusionDelegateDeps & { briefs: string[] } {
  let minted = 0;
  const d = {
    briefs: [] as string[],
    runTurn: async (_s: unknown, message: string) => {
      d.briefs.push(message);
      writeFileSync(join(dir, "a.txt"), `attempt ${d.briefs.length}`);
      return {
        session: createEmptySessionState({ id: "s-w", workingDir: dir }),
        reason: "reply",
        stepCount: 1,
      } as RunTurnResult;
    },
    createEphemeralSession: (meta: never) => {
      minted += 1;
      return createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
        workingDir: dir,
        metadata: { fusionWorker: { ...(meta as object) } },
      });
    },
    approvals: {
      setSessionPolicy: () => {},
      clearSessionPolicy: () => {},
      fanoutScopes: new FanoutScopeRegistry(),
    },
    approvalRequired: false,
    emitEvent: () => {},
    workingDir: dir,
    slotManager: { poolSize: () => 4 },
    resolveRunMode: () => mode(),
    workerSupportsSlotAffinity: () => false,
    warmWorkerBackend: async () => {},
    outputCharCap: 4000,
    logger,
    escalationComplete: complete,
    ...over,
  } as FusionDelegateDeps & { briefs: string[] };
  return d;
}

const TASK = [{ id: "t", title: "T", instructions: "write a.txt with the score", files: ["a.txt"] }];

describe("a node closes only on a green list (ATO-944)", () => {
  it("puts the list in the brief, re-runs a red task once with the findings, and fails it honestly if still red", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-d-"));
    let judged = 0;
    const d = deps(dir, async () => {
      judged += 1;
      return { content: JSON.stringify({ items: [{ id: "a2", pass: false, why: "no score in a.txt" }] }) };
    });
    const result = await buildFusionDelegateTool(d).run(
      { tasks: TASK },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    expect(d.briefs).toHaveLength(2);
    expect(d.briefs[0]).toContain("ACCEPTANCE CHECKLIST (read-only)");
    expect(d.briefs[1]).toContain("[a2] the task is done as instructed: write a.txt with the score — no score in a.txt");
    expect(judged).toBe(2);
    const row = (result.details.tasks as Array<{ status: string; error?: string }>)[0]!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/^judge: 1 of 2 acceptance items not met after one retry — a2 no score in a\.txt/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("names the delegating session on every judge call, for its spend readout (ATO-1388)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-sid-"));
    const sessions: Array<string | undefined> = [];
    const d = deps(dir, async (call) => {
      sessions.push(call.sessionId);
      return { content: JSON.stringify({ items: [{ id: "a2", pass: true, why: "ok" }] }) };
    });
    await buildFusionDelegateTool(d).run(
      { tasks: TASK },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((id) => id === "s-p")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("closes a task the retry fixed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-g-"));
    let judged = 0;
    const d = deps(dir, async () => {
      judged += 1;
      return {
        content: JSON.stringify({
          items: [{ id: "a2", pass: judged > 1, why: judged > 1 ? "score present" : "missing score" }],
        }),
      };
    });
    const result = await buildFusionDelegateTool(d).run(
      { tasks: TASK },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    const row = (result.details.tasks as Array<{ status: string; notes?: string[] }>)[0]!;
    expect(row.status).toBe("ok");
    expect(row.notes?.join(" ")).toContain("judge: all 2 acceptance items green after one retry");
    rmSync(dir, { recursive: true, force: true });
  });

  it("lets the retry of a task with no files split it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-s-"));
    const proposal =
      "Too big.\n```split_proposal\n" +
      JSON.stringify({
        tasks: [
          { id: "a", title: "A", instructions: "research part a" },
          { id: "b", title: "B", instructions: "research part b" },
        ],
      }) +
      "\n```";
    let judged = 0;
    const briefs: string[] = [];
    const d = deps(
      dir,
      async () => {
        judged += 1;
        return {
          content: JSON.stringify({
            items: [{ id: "a1", pass: judged > 1, why: judged > 1 ? "covered" : "too thin" }],
          }),
        };
      },
      { resolveRunMode: () => mode({ taskTree: { maxDepth: 2, maxNodes: 24 } }) },
    );
    d.runTurn = async (_session, message, options) => {
      briefs.push(message);
      const text = message.includes("research part")
        ? "part done"
        : briefs.length === 1
          ? "thin answer"
          : proposal;
      options.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text } });
      return {
        session: createEmptySessionState({ id: "s-w", workingDir: dir }),
        reason: "reply",
        stepCount: 1,
      } as RunTurnResult;
    };
    const result = await buildFusionDelegateTool(d).run(
      { tasks: [{ id: "t", title: "T", instructions: "research the market" }] },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    expect(briefs[1]).toContain("If this task is too big");
    expect(result.details.taskTree).toMatchObject({ splits: 1 });
    const row = (result.details.tasks as Array<{ status: string; reply: string }>)[0]!;
    expect(row.reply).toContain("[t/a] ok");
    expect(row.status).toBe("ok");
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the status of a retry that ended without being judged (stopped by the person)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-c-"));
    let runs = 0;
    const d = deps(dir, async () => ({
      content: JSON.stringify({ items: [{ id: "a2", pass: false, why: "no score" }] }),
    }));
    d.runTurn = async () => {
      runs += 1;
      writeFileSync(join(dir, "a.txt"), `attempt ${runs}`);
      return {
        session: createEmptySessionState({ id: "s-w", workingDir: dir }),
        reason: runs === 1 ? "reply" : "cancelled",
        stepCount: 1,
      } as RunTurnResult;
    };
    const result = await buildFusionDelegateTool(d).run(
      { tasks: TASK },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    const row = (result.details.tasks as Array<{ status: string; notes?: string[] }>)[0]!;
    expect(row.status).toBe("cancelled");
    expect(row.notes?.join(" ")).toMatch(/the retry ended cancelled and was not judged/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("changes nothing when the judge is off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-o-"));
    let judged = 0;
    const d = deps(
      dir,
      async () => {
        judged += 1;
        return { content: "{}" };
      },
      { resolveRunMode: () => mode({ judge: null }) },
    );
    const result = await buildFusionDelegateTool(d).run(
      { tasks: TASK },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    expect(judged).toBe(0);
    expect(d.briefs).toHaveLength(1);
    expect(d.briefs[0]).not.toContain("ACCEPTANCE CHECKLIST");
    expect((result.details.tasks as Array<{ status: string }>)[0]!.status).toBe("ok");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the retry brief carries a failing check's output", () => {
  it("quotes the output tail under the red check item, bounded", () => {
    const items: AcceptanceItem[] = [
      { id: "a1", kind: "check", text: "the check passes: {\"cmd\":\"npm test\"}", checkIndex: 0, judged: false },
    ];
    const text = renderRetryFindings(items, {
      green: false,
      costUsd: null,
      items: [
        {
          id: "a1",
          pass: false,
          why: "verify.run command: FAILED exit 1 after 9 ms",
          by: "fact",
          output: `${"z".repeat(5000)}\nAssertionError: expected 3 to equal 4`,
        },
      ],
    });
    expect(text).toContain("[a1] the check passes");
    expect(text).toContain("  output:\n");
    expect(text).toContain("    AssertionError: expected 3 to equal 4");
    expect((text.match(/z/g) ?? []).length).toBeLessThanOrEqual(RETRY_OUTPUT_CHARS);
  });

  it("reaches the retried worker's brief from a real failing check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-out-"));
    const d = deps(dir, answer([{ id: "a3", pass: true }]), {
      runChecks: async () => ({
        ok: false,
        results: [
          {
            ok: false,
            summary: "verify.run command: FAILED\nexit 1 after 5 ms\nstderr (tail):\nError: score is NaN\n    at hud.js:3:9",
            stderrTail: "Error: score is NaN\n    at hud.js:3:9",
          },
        ],
      }),
    });
    await buildFusionDelegateTool(d).run(
      {
        tasks: TASK,
        contract: { checks: [{ task: "t", kind: "command", cmd: "node hud.js" }] },
      },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    const retry = d.briefs.find((b) => b.includes("A judge found these acceptance items NOT met"));
    expect(retry).toBeDefined();
    expect(retry).toContain("    Error: score is NaN\n        at hud.js:3:9");
    rmSync(dir, { recursive: true, force: true });
  });

  it("masks a secret in the check output before the retry brief quotes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-mask-"));
    const d = deps(dir, answer([{ id: "a3", pass: true }]), {
      runChecks: async () => ({
        ok: false,
        results: [
          {
            ok: false,
            summary: "verify.run command: FAILED\nexit 1 after 5 ms",
            stderrTail: "Error: auth failed for sk_live_abcdefghijklmnop1234 at db.js:3:9",
          },
        ],
      }),
    });
    await buildFusionDelegateTool(d).run(
      {
        tasks: TASK,
        contract: { checks: [{ task: "t", kind: "command", cmd: "node db.js" }] },
      },
      { workingDir: dir, sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal },
    );
    const retry = d.briefs.find((b) => b.includes("A judge found these acceptance items NOT met"));
    expect(retry).toBeDefined();
    expect(retry).toContain("Error: auth failed for [redacted:stripe-key] at db.js:3:9");
    expect(retry).not.toContain("sk_live_abcdefghijklmnop1234");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("judge evidence", () => {
  const task: DelegateTask = { id: "t", title: "T", instructions: "edit a.txt", files: ["a.txt"] };

  it("without a diff (no isolation) reads each declared file's head, as before", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-ev-"));
    writeFileSync(join(dir, "a.txt"), "x".repeat(JUDGE_FILE_CHARS + 50));
    const evidence = await gatherEvidence(task, undefined, "", dir);
    expect(evidence.startsWith("### a.txt\n")).toBe(true);
    expect(evidence).toContain("[… 50 more chars clipped]");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the diff when the changes are known, shows an unchanged declared file's head, and masks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-ev-"));
    writeFileSync(join(dir, "a.txt"), "kept\n");
    const secret = "sk-test-" + "Z".repeat(32);
    const evidence = await gatherEvidence(
      { ...task, files: ["a.txt", "b.txt"] },
      undefined,
      "",
      dir,
      [
        {
          path: "b.txt",
          kind: "modified",
          patch: `--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-old\n+key=${secret}\n`,
        },
      ],
      [{ label: "TEST_KEY", value: secret }],
    );
    expect(evidence).toContain("Touched files: b.txt (modified)");
    expect(evidence).toContain("Declared but not changed: a.txt");
    expect(evidence).toContain("### a.txt (unchanged)\nkept");
    expect(evidence).toContain("-old");
    expect(evidence).not.toContain(secret);
    rmSync(dir, { recursive: true, force: true });
  });

  it("masks a secret the clip would cut in half: masked first, then clipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-ev-"));
    const secret = "Kx9qWmTr4vLp8nZs2bYc7hJd3fGa";
    const known = [{ label: "TEST_KEY", value: secret }];
    // The secret starts just before the per-file diff cap and the file-head cap.
    const header = "--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n+";
    const pad = "p".repeat(JUDGE_DIFF_FILE_CHARS - header.length - 10);
    const diff = await gatherEvidence(
      { ...task, files: ["b.txt"] },
      undefined,
      "",
      dir,
      [{ path: "b.txt", kind: "modified", patch: `${header}${pad}${secret}\n` }],
      known,
    );
    expect(diff).not.toContain(secret.slice(0, 8));
    const added = await gatherEvidence(
      { ...task, files: ["c.txt"] },
      undefined,
      "",
      dir,
      [
        {
          path: "c.txt",
          kind: "added",
          patch: "--- /dev/null\n+++ b/c.txt\n",
          content: `${"c".repeat(JUDGE_FILE_CHARS - 10)}${secret}\n`,
        },
      ],
      known,
    );
    expect(added).not.toContain(secret.slice(0, 8));
    writeFileSync(join(dir, "a.txt"), `${"a".repeat(JUDGE_FILE_CHARS - 10)}${secret}\n`);
    const heads = await gatherEvidence(task, undefined, "", dir, undefined, known);
    expect(heads).not.toContain(secret.slice(0, 8));
    rmSync(dir, { recursive: true, force: true });
  });
});
