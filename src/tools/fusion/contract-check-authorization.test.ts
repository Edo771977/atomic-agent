import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ApprovalGate, type ApprovalRequest } from "../../approval/approval-gate.js";
import type { ApprovalRule } from "../../approval/approval-rules.js";
import { createContractCheckHold } from "./contract-check-hold.js";
import type { ContractCheckRunner } from "./contract-checks.js";

const cwd = resolve("contract-authorization-fixture");
const signal = new AbortController().signal;
function setup(options: { tainted?: boolean; rules?: ApprovalRule[]; deny?: boolean } = {}) {
  const requests: ApprovalRequest[] = [];
  const gate: ApprovalGate = new ApprovalGate({ level: 1, emit: request => {
    requests.push(request);
    queueMicrotask(() => gate.resolve({ approvalId: request.approvalId, approved: !options.deny }));
  } });
  gate.setTaintReview(() => true);
  if (options.tainted) gate.noteUntrustedContent("parent", "a web page");
  gate.setRules({ list: () => options.rules ?? [], add: () => { throw new Error("unused"); }, remove: () => false });
  const runner = Object.assign(vi.fn<ContractCheckRunner>(async specs => ({ ok: true, results: specs.map(() => ({ ok: true })) })), { supportsInputIntegrity: true as const });
  const hold = createContractCheckHold({ runner, approvals: gate, approvalRequired: true, sessionId: "parent", workingDir: cwd, tool: "fusion.delegate", checks: [{ kind: "command", cmd: "node", args: ["root.js"] }], signal });
  return { gate, requests, runner, hold };
}
const run = (hold: ReturnType<typeof createContractCheckHold>, specs: Record<string, unknown>[]) => hold.runner!(specs, { workingDir: cwd, signal });

describe("contract check authorization", () => {
  it("authorizes the complete actual batch before its runner even in a clean session", async () => {
    const { hold, runner, requests } = setup();
    await run(hold, [{ kind: "command", cmd: "node", args: ["child-a.js"] }, { kind: "command", cmd: "node", args: ["child-b.js"] }]);
    expect(requests.length).toBeGreaterThan(0);
    const preview = requests.map(r => r.preview).join("\n");
    expect(preview).toContain("child-a.js"); expect(preview).toContain("child-b.js");
    expect(preview).not.toContain("root.js");
    expect(runner).toHaveBeenCalledOnce();
  });

  it("does not let a root decision authorize different child batches", async () => {
    const { hold, requests } = setup({ tainted: true });
    await run(hold, [{ kind: "command", cmd: "node", args: ["child-a.js"] }]);
    const first = requests.length;
    await run(hold, [{ kind: "command", cmd: "node", args: ["child-b.js"] }]);
    expect(requests.length).toBeGreaterThan(first);
    expect(requests.at(-1)?.preview).toContain("child-b.js");
  });

  it.each(["ask", "deny"] as const)("honors a saved shell %s command rule for checks before runner execution", async decision => {
    const rule: ApprovalRule = { id: "node-policy", decision, tool: "os.shell.run", category: "shell", commandPrefix: ["node"], source: "user", createdAt: "2026-11-14" };
    const { hold, runner, requests } = setup({ tainted: true, rules: [rule] });
    if (decision === "deny") {
      await expect(run(hold, [{ kind: "command", cmd: "node", args: ["denied.js"] }])).rejects.toThrow(/rule/);
      expect(runner).not.toHaveBeenCalled(); expect(requests).toEqual([]);
    } else {
      await run(hold, [{ kind: "command", cmd: "node", args: ["ask.js"] }]);
      expect(requests[0]?.commandSegments).toContainEqual(["node", "ask.js"]);
    }
  });

  it("shows complete arguments, cwd, env and declarations without leaking env credentials", async () => {
    const { hold, requests } = setup({ tainted: true });
    const long = "x".repeat(180) + "-visible-tail.js";
    await run(hold, [{ kind: "command", cmd: "node", args: [long, "two words"], cwd: "sub", env: { NODE_ENV: "test", API_TOKEN: "fixture-secret-value" }, network: false, timeoutMs: 1234 }]);
    const preview = requests.map(r => r.preview).join("\n");
    expect(preview).toContain("-visible-tail.js"); expect(preview).toContain("two words");
    expect(preview).toContain("sub"); expect(preview).toContain("NODE_ENV"); expect(preview).toContain("1234");
    expect(preview).not.toContain("fixture-secret-value");
  });

  it("retains input-integrity capability and passes its guard unchanged", async () => {
    const { hold, runner } = setup();
    const inputIntegrity = { paths: ["test.js"], begin: async () => async () => {} };
    await hold.runner!([{ kind: "command", cmd: "node", args: ["test.js"] }], { workingDir: cwd, signal, inputIntegrity });
    expect(hold.runner?.supportsInputIntegrity).toBe(true);
    expect(runner.mock.calls[0]?.[1].inputIntegrity).toBe(inputIntegrity);
  });
});

describe("contract check saved-rule boundaries", () => {
  const policy = (decision: "allow" | "ask" | "deny", extra: Partial<ApprovalRule> = {}): ApprovalRule => ({ id: `fixture-${decision}`, decision, tool: "os.shell.run", category: "shell", source: "user", createdAt: "2026-11-14", ...extra });
  it("preflights a later denied command before executing any command in the batch", async () => {
    const { hold, runner, requests } = setup({ rules: [policy("deny", { commandPrefix: ["node", "denied.js"] })] });
    await expect(run(hold, [{ kind: "command", cmd: "node", args: ["allowed.js"] }, { kind: "command", cmd: "node", args: ["denied.js"] }])).rejects.toThrow(/rule/);
    expect(runner).not.toHaveBeenCalled(); expect(requests).toHaveLength(0);
  });
  it("does not broaden an os.shell.run tool-only allow to verification checks", async () => {
    const { hold, requests } = setup({ rules: [policy("allow")] });
    await run(hold, [{ kind: "command", cmd: "node", args: ["needs-confirmation.js"] }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tool).toBe("verify.run");
  });
  it("uses the original project for project rules when a candidate source is private", async () => {
    const rule = policy("deny", { commandPrefix: ["node"], project: cwd, path: cwd });
    const { hold, runner } = setup({ rules: [rule] });
    await expect(hold.runner!([{ kind: "command", cmd: "node", args: ["test.js"], cwd: "sub" }], { workingDir: resolve("private-candidate-fixture"), signal })).rejects.toThrow(/rule/);
    expect(runner).not.toHaveBeenCalled();
  });
  it("refuses oversized consent instead of silently hiding the command tail", async () => {
    const { hold, runner, requests } = setup({ tainted: true });
    await expect(run(hold, [{ kind: "command", cmd: "node", args: ["x".repeat(100_000)] }])).rejects.toThrow(/large|limit|size/i);
    expect(runner).not.toHaveBeenCalled(); expect(requests).toEqual([]);
  });
});

describe("contract authorization cancellation and worker ownership", () => {
  it("cancels an active and queued request without leaving a pending prompt or executing either", async () => {
    const emitted: ApprovalRequest[] = [];
    const gate = new ApprovalGate({ level: 1, emit: request => { emitted.push(request); } });
    const runner = vi.fn<ContractCheckRunner>();
    const hold = createContractCheckHold({ runner, approvals: gate, approvalRequired: true, sessionId: "parent", workingDir: cwd, tool: "fusion.delegate", checks: [], signal });
    const first = new AbortController(), queued = new AbortController();
    const pending = hold.runner!([{ kind: "command", cmd: "node", args: ["one.js"] }], { workingDir: cwd, signal: first.signal });
    const pendingAssertion = expect(pending).rejects.toThrow(/cancelled/);
    await vi.waitFor(() => expect(gate.pendingCount()).toBe(1));
    const waiting = hold.runner!([{ kind: "command", cmd: "node", args: ["two.js"] }], { workingDir: cwd, signal: queued.signal });
    queued.abort(); await expect(waiting).rejects.toThrow(/cancelled/);
    expect(emitted).toHaveLength(1);
    first.abort(); await pendingAssertion;
    expect(gate.pendingCount()).toBe(0); expect(runner).not.toHaveBeenCalled();
  });
  it("respects a worker refuse policy without emitting an invisible request", async () => {
    const emitted = vi.fn();
    const gate = new ApprovalGate({ level: 1, emit: emitted });
    gate.setSessionPolicy("worker", { onPrompt: "refuse", reason: "worker cannot ask" });
    const runner = vi.fn<ContractCheckRunner>();
    const hold = createContractCheckHold({ runner, approvals: gate, approvalRequired: true, sessionId: "worker", workingDir: cwd, tool: "fusion.delegate", checks: [], signal });
    await expect(run(hold, [{ kind: "command", cmd: "node", args: ["worker.js"] }])).rejects.toThrow(/worker cannot ask/);
    expect(emitted).not.toHaveBeenCalled(); expect(gate.pendingCount()).toBe(0); expect(runner).not.toHaveBeenCalled();
  });
});

describe("contract command read boundaries", () => {
  it("checks protected state files through the same read guard before a runner", async () => {
    const { createCommandReadCheck } = await import("../read-scope/confine-reads.js");
    const secretPath = resolve(cwd, "agent-state", "config.json");
    const emitted: ApprovalRequest[] = [];
    const gate: ApprovalGate = new ApprovalGate({ level: 4, emit: req => { emitted.push(req); queueMicrotask(() => gate.resolve({ approvalId: req.approvalId, approved: false })); } });
    const runner = vi.fn<ContractCheckRunner>();
    const checkCommandReads = createCommandReadCheck({ approvals: { approvals: gate, approvalRequired: true }, grantedDirs: () => [], readScope: () => "working-dir", stateSecrets: { stateDir: resolve(cwd, "agent-state"), files: [secretPath] } });
    const hold = createContractCheckHold({ runner, approvals: gate, approvalRequired: true, sessionId: "parent", workingDir: cwd, tool: "fusion.delegate", checks: [], signal, checkCommandReads });
    await expect(run(hold, [{ kind: "command", cmd: "node", args: [secretPath] }])).rejects.toThrow();
    expect(emitted.map(r => r.category)).toEqual(["state_secret"]); expect(runner).not.toHaveBeenCalled();
  });
  it("does not let a caller-supplied approval flag or outside cwd bypass policy", async () => {
    const { hold, runner } = setup();
    await expect(run(hold, [{ kind: "command", cmd: "node", args: ["test.js"], cwd: resolve(cwd, "..", "outside"), approvalRequired: false }])).rejects.toThrow(/cwd/);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("trusted custom check compatibility", () => {
  it("refuses an undisclosed executor in production even when a worker sends approvalRequired false", async () => {
    const { hold, runner, requests } = setup();
    await expect(run(hold, [{ kind: "command", file: "fixture.txt", approvalRequired: false }])).rejects.toThrow(/no disclosed command/);
    expect(requests).toEqual([]); expect(runner).not.toHaveBeenCalled();
  });
  it("preserves non-process custom specs for an explicitly trusted embedder", async () => {
    const runner = vi.fn<ContractCheckRunner>(async specs => ({ ok: true, results: specs.map(() => ({ ok: true })) }));
    const hold = createContractCheckHold({ runner, approvals: {}, approvalRequired: false, sessionId: "fixture", workingDir: cwd, tool: "fusion.delegate", checks: [], signal });
    const spec = { kind: "command", file: "fixture.txt" };
    await run(hold, [spec]); expect(runner.mock.calls[0]?.[0]).toEqual([spec]);
  });
  it("refuses credential-bearing policy metadata before exposing a prompt", async () => {
    const { hold, runner, requests } = setup();
    await expect(run(hold, [{ kind: "command", cmd: "node", args: ["fixture.mjs", "long-fixture-secret-value"], env: { API_TOKEN: "long-fixture-secret-value" } }])).rejects.toThrow(/credentials/);
    expect(requests).toEqual([]); expect(runner).not.toHaveBeenCalled();
  });
});
