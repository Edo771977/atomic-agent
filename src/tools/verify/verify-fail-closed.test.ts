import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser } from "playwright-core";

import type { AtomicAgentConfig } from "../../config/index.js";
import type { ApprovalGate } from "../../approval/approval-gate.js";
import * as commands from "./run-command-kind.js";
import * as services from "./run-service-kind.js";
import * as pages from "./run-page-kind.js";
import { runChecks, runVerify, type VerifyRunContext } from "./run-verify.js";
import { buildVerifyRunTool } from "./verify-run.js";
import { createVerifyWorkspace, type VerifyWorkspace } from "./verify-workspace-copy.js";

const config: Pick<AtomicAgentConfig, "browser"> = {
  browser: { enabled: false, channel: "chrome", headless: true, cdpUrl: null, connect: "agent", userChromeDataDir: null, executablePath: null, noSandbox: false, launchTimeoutMs: 1000, blockedDomains: [], allowedDomains: [] },
};
const spec = { kind: "command", cmd: process.execPath, args: ["-e", "require('fs').writeFileSync('original.txt','changed')"], checks: ["exit 0"] };
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "verify-fail-closed-"));
  await writeFile(join(dir, "original.txt"), "original");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("verify refuses to execute without a private workspace", () => {
  it("the public tool fails closed at the copy limit before starting the runner", async () => {
    const runner = vi.spyOn(commands, "runCommandKind");
    const options = {
      config, approvalRequired: false, approvals: {} as ApprovalGate,
      workspace: (cwd: string) => createVerifyWorkspace(cwd, { maxBytes: 1 }),
    };
    const tool = buildVerifyRunTool(options);
    const result = await tool.run(spec, { workingDir: dir, sessionId: "verify-test", stepIndex: 0, signal: new AbortController().signal });
    expect(result.status).toBe("error");
    expect(result.details).toMatchObject({ ok: false, isolated: false, errorCode: "workspace-unavailable" });
    expect(result.summary).toContain("copy limit");
    expect(runner).not.toHaveBeenCalled();
    expect(await readFile(join(dir, "original.txt"), "utf8")).toBe("original");
  });

  it("honours tools.verify.maxCopyBytes from the config for the default workspace", async () => {
    const runner = vi.spyOn(commands, "runCommandKind");
    const tiny = { ...config, tools: { verify: { maxCopyBytes: 1 } } };
    const refused = await runVerify(spec, { workingDir: dir, config: tiny });
    expect(refused).toMatchObject({ ok: false, errorCode: "workspace-unavailable" });
    expect(refused.summary).toContain("tools.verify.maxCopyBytes");
    expect(runner).not.toHaveBeenCalled();
    const roomy = { ...config, tools: { verify: { maxCopyBytes: 1_000_000 } } };
    const ran = await runVerify(spec, { workingDir: dir, config: roomy });
    expect(ran).toMatchObject({ ok: true, isolated: true });
    expect(await readFile(join(dir, "original.txt"), "utf8")).toBe("original");
  });

  it("copy errors return a failed check without running in the original", async () => {
    const runner = vi.spyOn(commands, "runCommandKind");
    const tmpRoot = join(dir, "not-a-directory");
    await writeFile(tmpRoot, "file");
    const result = await runVerify(spec, { workingDir: dir, workspace: (cwd) => createVerifyWorkspace(cwd, { tmpRoot }) });
    expect(result).toMatchObject({ ok: false, isolated: false, errorCode: "workspace-unavailable", checks: [{ ok: false }] });
    expect(result.error).toContain("copy");
    expect(runner).not.toHaveBeenCalled();
    expect(await readFile(join(dir, "original.txt"), "utf8")).toBe("original");
  });

  it.each([
    { kind: "command", cmd: process.execPath },
    { kind: "service", start: { cmd: process.execPath }, ready: { port: 12345 } },
    { kind: "page", path: "index.html" },
    { kind: "page", url: "http://127.0.0.1:12345", start: { cmd: process.execPath } },
  ])("never starts the $kind executor when an embedder supplies an unisolated workspace", async (args) => {
    const command = vi.spyOn(commands, "runCommandKind").mockRejectedValue(new Error("must not run"));
    const service = vi.spyOn(services, "runServiceKind").mockRejectedValue(new Error("must not run"));
    const page = vi.spyOn(pages, "runPageKind").mockRejectedValue(new Error("must not run"));
    const cleanup = vi.fn(async () => {});
    // Legacy/custom embedders are checked at the execution boundary too.
    const workspace = async (): Promise<VerifyWorkspace> => ({ dir, isolated: false, method: "in-place", cleanup });
    const result = await runVerify(args, { workingDir: dir, config, workspace });
    expect(result).toMatchObject({ ok: false, isolated: false, errorCode: "workspace-unavailable" });
    expect(command).not.toHaveBeenCalled();
    expect(service).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("contains a workspace factory exception for direct and contract callers", async () => {
    const context: VerifyRunContext = { workingDir: dir, workspace: async () => { throw new Error("copy denied"); } };
    const result = await runVerify(spec, context);
    expect(result).toMatchObject({ ok: false, isolated: false, errorCode: "workspace-unavailable" });
    expect(result.error).toContain("copy denied");
    const checks = await runChecks([spec], context);
    expect(checks).toMatchObject({ ok: false, results: [{ isolated: false, checks: [{ ok: false }] }] });
  });

  it("cancellation while copying prevents execution and removes the completed copy", async () => {
    const controller = new AbortController();
    let copy = "";
    const runner = vi.spyOn(commands, "runCommandKind");
    const result = await runVerify(spec, { workingDir: dir, signal: controller.signal, workspace: async (cwd) => {
      const workspace = await createVerifyWorkspace(cwd);
      copy = workspace.dir;
      controller.abort();
      return workspace;
    } });
    expect(result).toMatchObject({ ok: false, errorCode: "cancelled" });
    expect(runner).not.toHaveBeenCalled();
    await expect(readdir(copy)).rejects.toThrow();
    expect(await readFile(join(dir, "original.txt"), "utf8")).toBe("original");
  });

  it("an already cancelled call creates no copy and starts no runner", async () => {
    const controller = new AbortController();
    controller.abort();
    const workspace = vi.fn(async () => createVerifyWorkspace(dir));
    const runner = vi.spyOn(commands, "runCommandKind");
    const result = await runVerify(spec, { workingDir: dir, signal: controller.signal, workspace });
    expect(result).toMatchObject({ ok: false, errorCode: "cancelled" });
    expect(workspace).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("contains cleanup failures and still refuses execution", async () => {
    const runner = vi.spyOn(commands, "runCommandKind");
    const cleanup = vi.fn(async () => { throw new Error("cleanup denied"); });
    const result = await runVerify(spec, { workingDir: dir, workspace: async () => ({ dir, isolated: false, method: "in-place", cleanup }) });
    expect(result).toMatchObject({ ok: false, isolated: false, errorCode: "workspace-cleanup-failed", checks: [{ ok: false }] });
    expect(result.error).toContain("cleanup denied");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(runner).not.toHaveBeenCalled();
  });

  it("the public page tool reports cancellation when a loaded page skips its required script", async () => {
    const controller = new AbortController();
    const click = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const page = { on() {}, async addInitScript() {}, async goto() { controller.abort(); }, click, async evaluate() { return []; } };
    const browser = { async newContext() { return { async route() {}, async newPage() { return page; } }; }, close } as unknown as Browser;
    let copy = "";
    const cleanup = vi.fn(async () => {});
    const tool = buildVerifyRunTool({ config, approvals: {} as ApprovalGate, approvalRequired: false,
      launchBrowser: async () => browser,
      workspace: async (cwd) => {
        const workspace = await createVerifyWorkspace(cwd);
        copy = workspace.dir;
        cleanup.mockImplementation(() => workspace.cleanup());
        return { ...workspace, cleanup };
      },
    });
    const result = await tool.run({ kind: "page", url: "http://localhost", script: [{ action: "click", selector: "#must-run" }], checks: ["no errors"] },
      { workingDir: dir, sessionId: "verify-test", stepIndex: 0, signal: controller.signal });
    expect(controller.signal.aborted).toBe(true);
    expect(click).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
    expect(result.details).toMatchObject({ ok: false, errorCode: "cancelled", checks: [{ ok: false }] });
    expect(result.summary).toContain("cancelled");
    expect(close).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(readdir(copy)).rejects.toThrow();
    expect(await readFile(join(dir, "original.txt"), "utf8")).toBe("original");
  });

  it.each(["command", "service", "page"])("returns typed cancellation when the %s executor returns normally after abort", async (kind) => {
    const controller = new AbortController();
    vi.spyOn(commands, "runCommandKind").mockImplementation(async () => {
      controller.abort();
      return { commandLine: "test", exitCode: 0, signal: null, timedOut: false, aborted: true, stdout: "", stderr: "", stdoutTail: "", stderrTail: "", durationMs: 0 };
    });
    vi.spyOn(services, "runServiceKind").mockImplementation(async () => {
      controller.abort();
      return { commandLine: "test", ready: true, readyMs: 0, requests: [], exitCode: 0, timedOut: false, stdout: "", stderr: "", stdoutTail: "", stderrTail: "", durationMs: 0 };
    });
    vi.spyOn(pages, "runPageKind").mockImplementation(async () => {
      controller.abort();
      return { target: "test", launched: true, loaded: true, errors: [], consoleErrors: [], consoleWarnings: [], requestFailures: [], missingSelectors: [], probes: {}, durationMs: 0 };
    });
    const args = kind === "command" ? { kind, cmd: process.execPath } : kind === "service" ? { kind, start: { cmd: process.execPath }, ready: { port: 12345 } } : { kind, url: "http://localhost" };
    const result = await runVerify(args, { workingDir: dir, config, signal: controller.signal });
    expect(result).toMatchObject({ ok: false, errorCode: "cancelled" });
    expect(result.error).toContain("cancelled");
  });
});
