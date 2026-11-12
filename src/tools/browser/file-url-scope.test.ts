import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ApprovalGate, type ApprovalLevel, type ApprovalRequest } from "../../approval/index.js";
import type { ReadScope } from "../../config/index.js";
import { ToolRegistry, type ToolContext } from "../tool-registry.js";
import { confineReads } from "../read-scope/confine-reads.js";
import { GateBackend } from "./browser-gate-test-helpers.js";
import { buildBrowserNavigateTool, buildBrowserTabsTool } from "./index.js";

/**
 * A file:// page is a local read: it goes through the agent's secret-file
 * check and the read scope like the fs read tools, and a session grant on
 * one local page covers that page's directory only.
 */
describe("browser file:// navigation", () => {
  let root: string;
  let work: string;
  let stateDir: string;
  let backend: GateBackend;
  let registry: ToolRegistry;
  let gate: ApprovalGate;
  let prompts: ApprovalRequest[];
  let decide: (r: ApprovalRequest) => { approved: boolean; grant?: "category" };
  let readScope: ReadScope;

  const ctx = (): ToolContext => ({
    sessionId: "s",
    workingDir: work,
    stepIndex: 0,
    signal: new AbortController().signal,
  });
  const url = (path: string) => pathToFileURL(path).href;
  const navigate = (target: string) =>
    registry.invoke("browser.navigate", { url: target }, ctx());

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "browser-file-url-"));
    work = join(root, "work");
    stateDir = join(root, "state");
    for (const dir of [work, stateDir, join(root, "a"), join(root, "b")]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(stateDir, "config.json"), "{}");
    writeFileSync(join(stateDir, ".env"), "KEY=x");
    prompts = [];
    readScope = "unrestricted";
    decide = () => ({ approved: true, grant: "category" });
    gate = new ApprovalGate({
      level: 3 as ApprovalLevel,
      emit: (request) => {
        prompts.push(request);
        queueMicrotask(() =>
          gate.resolve({ approvalId: request.approvalId, ...decide(request) }),
        );
      },
    });
    const options = { approvals: gate, approvalRequired: true };
    backend = new GateBackend();
    registry = new ToolRegistry();
    registry.register(buildBrowserNavigateTool(backend, options));
    registry.register(buildBrowserTabsTool(backend, options));
    confineReads(registry, {
      grantedDirs: () => [],
      readScope: () => readScope,
      approvals: options,
      stateSecrets: {
        stateDir,
        files: [join(stateDir, "config.json"), join(stateDir, ".env")],
      },
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("a session grant for one local page does not cover another directory", async () => {
    await navigate(url(join(root, "a", "page.html")));
    await navigate(url(join(root, "a", "next.html")));
    expect(prompts.map((p) => p.category)).toEqual(["browser_nonweb"]);
    await navigate(url(join(root, "b", "other.html")));
    expect(prompts.map((p) => p.category)).toEqual(["browser_nonweb", "browser_nonweb"]);
    expect(backend.navigations).toHaveLength(3);
  });

  it("a file:// URL to the agent's own secrets asks as state_secret despite a grant", async () => {
    await navigate(url(join(stateDir, "notes.html")));
    expect(prompts.map((p) => p.category)).toEqual(["browser_nonweb"]);
    decide = (r) => ({ approved: r.category !== "state_secret" });
    for (const target of [
      url(join(stateDir, "config.json")),
      `view-source:${url(join(stateDir, ".env"))}`,
    ]) {
      await expect(navigate(target)).rejects.toMatchObject({
        name: "ApprovalDeniedError",
      });
    }
    expect(prompts.slice(1).map((p) => p.category)).toEqual([
      "state_secret",
      "state_secret",
    ]);
    expect(backend.navigations).toHaveLength(1);
  });

  it("a new tab on a secret file asks as state_secret too", async () => {
    decide = (r) => ({ approved: r.category !== "state_secret" });
    await expect(
      registry.invoke(
        "browser.tabs",
        { action: "new", url: url(join(stateDir, "config.json")) },
        ctx(),
      ),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(prompts.map((p) => p.category)).toEqual(["state_secret"]);
    expect(backend.tabCalls).toBe(0);
  });

  it("under the working-dir scope a local page outside it asks as a read", async () => {
    readScope = "working-dir";
    decide = (r) => ({ approved: r.category !== "fs_read_outside" });
    // Off the temp directory, which is scratch and never asked about.
    const result = await navigate("file:///srv/elsewhere/page.html");
    expect(result.status).toBe("error");
    expect(prompts.map((p) => p.category)).toEqual(["fs_read_outside"]);
    expect(backend.navigations).toHaveLength(0);
  });
});
