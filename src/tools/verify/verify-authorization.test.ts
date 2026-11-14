import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runChecks, runVerify } from "./run-verify.js";
import { runCommandKind } from "./run-command-kind.js";
vi.mock("./run-service-kind.js", () => ({ runServiceKind: vi.fn(async () => { throw new Error("executor should have been refused"); }) }));
vi.mock("./run-page-kind.js", () => ({ runPageKind: vi.fn(async () => { throw new Error("executor should have been refused"); }), defaultBrowserLauncher: vi.fn() }));
vi.mock("./run-command-kind.js", () => ({ runCommandKind: vi.fn(async () => ({ commandLine: "fixture", exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: "", stderr: "", stdoutTail: "", stderrTail: "", durationMs: 0 })) }));
const workingDir = resolve("verification-source-fixture");
const dir = resolve("verification-copy-fixture");
const ctx = () => ({ workingDir, signal: new AbortController().signal, workspace: async () => ({ dir, isolated: true, method: "copy" as const, cleanup: async () => {} }) });
beforeEach(() => vi.clearAllMocks());

describe("verification programmatic pre-execution policy", () => {
  it("refuses a hardline command in runChecks without reaching the executor", async () => {
    const result = await runChecks([{ kind: "command", cmd: "rm", args: ["-rf", "~"] }], ctx());
    expect(result.ok).toBe(false);
    expect(result.results[0]?.error).toMatch(/shell guard.*hardline/);
    expect(runCommandKind).not.toHaveBeenCalled();
  });

  it("refuses a hardline service or page start without launching anything", async () => {
    for (const kind of ["service", "page"]) {
      const result = await runVerify({ kind, start: { cmd: "rm", args: ["-rf", "~"] }, ready: { port: 3000 }, url: "http://127.0.0.1:3000" }, ctx());
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/shell guard.*hardline/);
    }
    expect(runCommandKind).not.toHaveBeenCalled();
  });

  it("cancellation before preparation starts no executor", async () => {
    const controller = new AbortController(); controller.abort();
    const workspace = vi.fn();
    const result = await runVerify({ kind: "command", cmd: "node", args: ["safe.js"] }, { ...ctx(), signal: controller.signal, workspace });
    expect(result.errorCode).toBe("cancelled"); expect(workspace).not.toHaveBeenCalled(); expect(runCommandKind).not.toHaveBeenCalled();
  });
});


describe("verification environment and lifecycle", () => {
  it("classifies command-defining git environment as dangerous", async () => {
    const { guardVerifyRun } = await import("./verify-run-guard.js");
    const { parseVerifyRunArgs } = await import("./verify-run-args.js");
    const guard = guardVerifyRun(parseVerifyRunArgs({ kind: "command", cmd: "git", args: ["status"], env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "fixture-program" } }), workingDir);
    expect(guard.dangerous[0]?.verdict.rule).toMatch(/^dangerous\./);
  });
  it("applies injected live operator policy to the actual rebased command", async () => {
    const result = await runVerify({ kind: "command", cmd: "git", args: ["push"] }, { ...ctx(), shellPolicy: { isGitRemoteSyncEnabled: () => false } });
    expect(result.ok).toBe(false); expect(result.error).toContain("policy.git_remote_sync_off"); expect(runCommandKind).not.toHaveBeenCalled();
  });
});
