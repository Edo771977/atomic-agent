import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { pathToFileURL } from "node:url";

import { ApprovalGate, type ApprovalLevel, type ApprovalRequest } from "../../approval/index.js";
import type { ReadScope } from "../../config/index.js";
import { ToolRegistry, type ToolContext } from "../tool-registry.js";
import {
  confineReads,
  localPageCheck,
  type ConfineReadsOptions,
} from "../read-scope/confine-reads.js";
import { GateBackend } from "./browser-gate-test-helpers.js";
import { buildBrowserTools } from "./index.js";
import { gatePageRead, localPageRefusal } from "./gate-page-read.js";

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
    // The runtime's wiring: one set of confinement options for the
    // dispatch-time read checks and the browser's landed-page check.
    const confinement: ConfineReadsOptions = {
      grantedDirs: () => [],
      readScope: () => readScope,
      approvals: options,
      stateSecrets: {
        stateDir,
        files: [join(stateDir, "config.json"), join(stateDir, ".env")],
      },
    };
    const policy = {
      blockedDomains: [],
      allowedDomains: [],
      localPages: localPageCheck(confinement),
    };
    for (const tool of buildBrowserTools(backend, options, policy)) registry.register(tool);
    confineReads(registry, confinement);
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

  it("a grant on a directory listing covers that directory, not its parent", async () => {
    const listing = `${url(join(root, "a"))}/`;
    await navigate(listing);
    await navigate(url(join(root, "a", "page.html")));
    expect(prompts.map((p) => p.category)).toEqual(["browser_nonweb"]);
    await navigate(url(join(root, "sibling.html")));
    expect(prompts.map((p) => p.category)).toEqual(["browser_nonweb", "browser_nonweb"]);
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

  it("an approved secret page opens, and its world snapshot is captured", async () => {
    const result = await navigate(url(join(stateDir, ".env")));
    expect(result.status).toBe("ok");
    expect(prompts.map((p) => p.category)).toEqual(["state_secret", "browser_nonweb"]);
    expect(result.details.worldSnapshot).toBeDefined();
  });

  it("a page that redirects to a secret file is cleared and refused", async () => {
    // An in-scope report whose meta refresh goes to the agent's `.env`.
    const report = url(join(work, "report.html"));
    backend.redirects.set(report, url(join(stateDir, ".env")));
    const result = await navigate(report);
    expect(result.status).toBe("error");
    expect(result.details.reason).toBe("local_file_refused");
    expect(result.summary).toContain(join(stateDir, ".env"));
    expect(backend.url).toBe("about:blank");
    expect(backend.snapshots).toBe(0);
    expect(prompts.map((p) => p.category)).toEqual(["browser_nonweb"]);
  });

  it("a click that lands outside the read scope is cleared and refused", async () => {
    readScope = "working-dir";
    backend.url = url(join(work, "index.html"));
    // A file:// directory listing's parent link, off the temp directory.
    backend.landAfterAction = `${url(join(parse(root).root, "srv", "elsewhere"))}/`;
    const result = await registry.invoke("browser.click", { ref: "e1" }, ctx());
    expect(result.status).toBe("error");
    expect(result.details.reason).toBe("local_file_refused");
    expect(backend.url).toBe("about:blank");
    expect(prompts).toEqual([]);
  });

  it("a click that lands on a secret file is cleared and refused at any scope", async () => {
    backend.url = url(join(work, "index.html"));
    backend.landAfterAction = url(join(stateDir, "config.json"));
    const result = await registry.invoke("browser.click", { ref: "e1" }, ctx());
    expect(result.status).toBe("error");
    expect(result.details.reason).toBe("local_file_refused");
    expect(backend.url).toBe("about:blank");
  });

  it("read_aria and screenshot refuse a page sitting on a secret file", async () => {
    // However the tab got there (a navigation that started after a click
    // returned), the page text never reaches the model.
    backend.url = url(join(stateDir, ".env"));
    const read = await registry.invoke("browser.read_aria", {}, ctx());
    expect(read.status).toBe("error");
    expect(read.details.reason).toBe("local_file_refused");
    const shot = await registry.invoke("browser.screenshot", {}, ctx());
    expect(shot.status).toBe("error");
    expect(shot.details.reason).toBe("local_file_refused");
    expect(backend.shots).toHaveLength(0);
  });

  it("read_aria on a local page inside the scope still reads", async () => {
    readScope = "working-dir";
    backend.url = url(join(work, "index.html"));
    const read = await registry.invoke("browser.read_aria", {}, ctx());
    expect(read.status).toBe("ok");
  });

  it("under the working-dir scope a local page outside it asks as a read", async () => {
    readScope = "working-dir";
    decide = (r) => ({ approved: r.category !== "fs_read_outside" });
    // Off the temp directory, which is scratch and never asked about.
    const result = await navigate(url(join(parse(root).root, "srv", "elsewhere", "page.html")));
    expect(result.status).toBe("error");
    expect(prompts.map((p) => p.category)).toEqual(["fs_read_outside"]);
    expect(backend.navigations).toHaveLength(0);
  });

  const unmappableUrls = [
    "file:///bad%00name.html",
    "view-source:file:///bad%00name.html",
    "file:///bad%ZZname.html",
    "file:///bad%2Fname.html",
    "file:///C:/bad%00name.html",
    "file://%ZZ/",
    ...(process.platform === "win32"
      ? ["file:///srv/elsewhere/page.html", "view-source:file:///srv/elsewhere/page.html"]
      : ["file://server/share/page.html"]),
  ];

  it.each(unmappableUrls)("refuses an unmappable local URL before navigating: %s", async (target) => {
    const result = await navigate(target);
    expect(result.status).toBe("error");
    expect(result.details.reason).toBe("local_file_refused");
    expect(backend.navigations).toHaveLength(0);
    expect(prompts).toEqual([]);
  });

  it.each(unmappableUrls)("refuses an unmappable local URL before opening a tab: %s", async (target) => {
    const result = await registry.invoke("browser.tabs", { action: "new", url: target }, ctx());
    expect(result.status).toBe("error");
    expect(result.details.reason).toBe("local_file_refused");
    expect(backend.tabCalls).toBe(0);
    expect(prompts).toEqual([]);
  });

  it.each(unmappableUrls)("clears a click landing on an unmappable local URL: %s", async (target) => {
    backend.landAfterAction = target;
    const result = await registry.invoke("browser.click", { ref: "e1" }, ctx());
    expect(result.status).toBe("error");
    expect(result.details.reason).toBe("local_file_refused");
    expect(backend.url).toBe("about:blank");
    expect(backend.snapshots).toBe(0);
  });

  it.each(unmappableUrls)("does not read or screenshot an unmappable local URL: %s", async (target) => {
    backend.url = target;
    for (const tool of ["browser.read_aria", "browser.screenshot"]) {
      const result = await registry.invoke(tool, {}, ctx());
      expect(result.status).toBe("error");
      expect(result.details.reason).toBe("local_file_refused");
      expect(result.details.worldSnapshot).toBeUndefined();
      expect(result.summary).not.toContain("secret page text");
    }
    expect(backend.shots).toHaveLength(0);
  });

  it.each(unmappableUrls)("does not exempt an unmappable requested URL or frame: %s", async (target) => {
    const policy = { blockedDomains: [], allowedDomains: [] };
    expect(localPageRefusal([target], policy, { reader: ctx(), allowUrl: target })).not.toBeNull();
    const verdict = await gatePageRead(
      { url: "https://example.com", frameUrls: [target] }, policy, "s",
    );
    expect(verdict.kind).toBe("local_file_refused");
  });

  it.each(unmappableUrls)("refuses an unmappable URL without a read-scope wrapper: %s", async (target) => {
    const bareRegistry = new ToolRegistry();
    for (const tool of buildBrowserTools(backend, { approvals: gate, approvalRequired: true })) {
      bareRegistry.register(tool);
    }
    expect((await bareRegistry.invoke("browser.navigate", { url: target }, ctx())).status).toBe("error");
    expect(backend.navigations).toHaveLength(0);
    expect(prompts).toEqual([]);
  });

  it("asks for a native absolute local path outside scratch and the read scope", async () => {
    readScope = "working-dir";
    decide = (request) => ({ approved: request.category !== "fs_read_outside" });
    const outside = join(parse(root).root, "atomic-scope-outside", "page.html");
    expect((await navigate(url(outside))).status).toBe("error");
    expect(prompts.map((request) => request.category)).toEqual(["fs_read_outside"]);
    expect(backend.navigations).toHaveLength(0);
  });
});
