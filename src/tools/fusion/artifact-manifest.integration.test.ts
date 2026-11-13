import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";
import type { WorkerTaskResult } from "./worker-result.js";
import { FusionRunStore } from "./run-checkpoint.js";
import { planResume } from "./run-resume.js";
import { collectArtifactManifest } from "./artifact-manifest.js";

describe("artifact evidence through Fusion results and checkpoints", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fusion-evidence-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function deps(): FusionDelegateDeps {
    return {
      runTurn: async (session, _brief, options) => {
        const path = join(session.workingDir, "artifact.txt");
        writeFileSync(path, "actual file bytes");
        options.eventHook?.({ type: "llm_event", event: { type: "tool_call_executed", result: { tool: "os.fs.write", status: "ok", summary: "written", details: { path, existed: false, addedLines: 1, removedLines: 0 }, truncated: false }, batchIndex: 0, batchSize: 1 } });
        options.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: "STATUS done. ALL TESTS PASSED npm test --token=never-record-this" } });
        return { session, reason: "reply", stepCount: 1 };
      },
      createEphemeralSession: (meta, workingDir) => createEmptySessionState({ id: "s-w-evidence", workingDir: workingDir ?? dir, metadata: { fusionWorker: { ...meta } } }),
      approvals: { setSessionPolicy() {}, clearSessionPolicy() {}, fanoutScopes: new FanoutScopeRegistry() },
      approvalRequired: false, emitEvent() {}, workingDir: dir, slotManager: { poolSize: () => 4 },
      resolveRunMode: () => ({ stored: "fusion", effective: "fusion", orchestratorProviderId: "cloud", orchestratorModel: "big", workerProviderId: "worker", workerModel: "small", workers: 1, workersPinned: true, workerMaxSteps: 7, workerTimeoutMs: 60_000, primaryProviderId: "cloud", degraded: null }),
      workerSupportsSlotAffinity: () => false, warmWorkerBackend: async () => {}, outputCharCap: 8000,
      logger: new StructuredLogger({ level: "error", sinks: [] }),
    };
  }

  it("emits actual artifact hashes but never treats a worker's false test claim as evidence", async () => {
    const d = deps();
    const result = await buildFusionDelegateTool(d).run({ tasks: [{ id: "core", instructions: "write artifact.txt", files: ["artifact.txt"] }], contract: { checks: [{ task: "core", kind: "command", cmd: "npm", args: ["test", "--token=never-record-this"] }] } }, { workingDir: dir, sessionId: "s-parent", stepIndex: 0, signal: new AbortController().signal });
    const row = (result.details.tasks as WorkerTaskResult[])[0]!;
    expect(row.artifactManifest).toBeDefined();
    expect(row.artifactManifest!.artifacts[0]).toMatchObject({ path: "artifact.txt", sha256: createHash("sha256").update("actual file bytes").digest("hex") });
    expect(row.artifactManifest!.checks).toContainEqual({ id: "contract:0", source: "contract", status: "unknown" });
    expect(JSON.stringify(row.artifactManifest)).not.toContain("never-record-this");
    expect(JSON.stringify(row.artifactManifest)).not.toContain("ALL TESTS PASSED");
    expect(result.details.artifactManifests).toEqual({ core: row.artifactManifest });
    expect(result.summary).toContain("manifest:");
  });

  it("round-trips runtime evidence through the existing v1 checkpoint and resume plan", async () => {
    writeFileSync(join(dir, "artifact.txt"), "bytes");
    const manifest = await collectArtifactManifest({ workingDir: dir, roots: [dir], artifacts: [{ path: "artifact.txt", change: "new", source: "file-tool" }], signal: new AbortController().signal });
    const store = new FusionRunStore({ dir: join(dir, "checkpoints") });
    const tasks = [{ id: "core", title: "Core", instructions: "write artifact.txt" }];
    const run = store.start({ sessionId: "s-parent", workingDir: dir, args: { tasks }, tasks, waveCount: 1 });
    run.recordTask({ id: "core", title: "Core", status: "ok", reply: "done", stepCount: 1, durationMs: 1, tools: { calls: 0, errors: 0, writes: 0, byTool: {} }, artifactManifest: manifest });
    run.finish("interrupted");
    const saved = store.load(run.runId)!;
    expect(saved.tasks[0]!.result?.artifactManifest).toEqual(manifest);
    expect(planResume(saved).carried[0]!.artifactManifest).toEqual(manifest);
  });

  it("rehashes carried evidence after a restart instead of trusting an old artifact digest", async () => {
    writeFileSync(join(dir, "artifact.txt"), "original");
    const manifest = await collectArtifactManifest({ workingDir: dir, roots: [dir], artifacts: [{ path: "artifact.txt", change: "new", source: "file-tool" }], signal: new AbortController().signal });
    const store = new FusionRunStore({ dir: join(dir, "checkpoints") });
    const tasks = [{ id: "core", title: "Core", instructions: "write artifact.txt" }];
    const run = store.start({ sessionId: "s-parent", workingDir: dir, args: { tasks }, tasks, waveCount: 1 });
    run.recordTask({ id: "core", title: "Core", status: "ok", reply: "done", stepCount: 1, durationMs: 1, tools: { calls: 0, errors: 0, writes: 0, byTool: {} }, artifactManifest: manifest });
    run.finish("interrupted");
    writeFileSync(join(dir, "artifact.txt"), "tampered after checkpoint");
    const d = deps();
    d.runCheckpoints = store;
    d.runTurn = async () => { throw new Error("settled task must not execute again"); };
    const result = await buildFusionDelegateTool(d).run({ resume: run.runId }, { workingDir: dir, sessionId: "s-parent", stepIndex: 0, signal: new AbortController().signal });
    const current = (result.details.tasks as WorkerTaskResult[])[0]!.artifactManifest!;
    expect(current.artifacts[0]!.sha256).toBe(createHash("sha256").update("tampered after checkpoint").digest("hex"));
    expect(current.artifacts[0]!.sha256).not.toBe(manifest.artifacts[0]!.sha256);
  });

  it.each(["empty", "null-path"])("does not republish a historical %s complete snapshot as current evidence on checkpoint resume", async variant => {
    writeFileSync(join(dir, "artifact.txt"), "current project bytes");
    const store = new FusionRunStore({ dir: join(dir, "checkpoints") });
    const tasks = [{ id: "core", title: "Core", instructions: "answer only" }];
    const run = store.start({ sessionId: "s-parent", workingDir: dir, args: { tasks }, tasks, waveCount: 1 });
    run.recordTask({ id: "core", title: "Core", status: "ok", reply: "done", stepCount: 1, durationMs: 1, tools: { calls: 0, errors: 0, writes: 0, byTool: {} } });
    run.finish("interrupted");
    const raw = store.load(run.runId)!;
    raw.tasks[0]!.result!.artifactManifest = {
      version: 1, coverage: { source: "snapshot", complete: true, reasons: [] }, checks: [], dependencies: [], omitted: 0,
      artifacts: variant === "empty" ? [] : [{ path: null, source: "snapshot", change: "new", kind: "file", state: "hashed", sha256: "0".repeat(64), bytes: 12 }],
      bytesHashed: variant === "empty" ? 0 : 12,
    };
    writeFileSync(join(dir, "checkpoints", `${run.runId}.json`), JSON.stringify(raw));
    const d = deps();
    d.runCheckpoints = store;
    d.runTurn = async () => { throw new Error("settled task must not execute again"); };
    const result = await buildFusionDelegateTool(d).run({ resume: run.runId }, { workingDir: dir, sessionId: "s-parent", stepIndex: 0, signal: new AbortController().signal });
    const current = (result.details.tasks as WorkerTaskResult[])[0]!.artifactManifest!;
    expect(current.coverage).toMatchObject({ source: "observed", complete: false });
    expect(current.artifacts.some(e => e.sha256 === "0".repeat(64))).toBe(false);
    expect(result.summary).not.toContain("manifest: snapshot");
  });

  it("bounds serialized evidence and strips unrecognized content/credential fields without losing the checkpoint", async () => {
    writeFileSync(join(dir, "artifact.txt"), "bytes");
    const manifest = await collectArtifactManifest({ workingDir: dir, roots: [dir], artifacts: [{ path: "artifact.txt", change: "new", source: "file-tool" }], signal: new AbortController().signal });
    const store = new FusionRunStore({ dir: join(dir, "checkpoints") });
    const tasks = [{ id: "core", title: "Core", instructions: "write artifact.txt" }];
    const run = store.start({ sessionId: "s-parent", workingDir: dir, args: { tasks }, tasks, waveCount: 1 });
    const oversized = { ...manifest, bytesHashed: 128 * 5,
      artifacts: Array.from({ length: 128 }, (_, i) => ({ ...manifest.artifacts[0]!, path: "p".repeat(4_000) + i, contents: "private-file-contents" })),
      checks: [{ id: "contract:0", source: "contract" as const, status: "pass" as const, credentialArgs: "never-record-this-token" }],
    };
    run.recordTask({ id: "core", title: "Core", status: "ok", reply: "done", stepCount: 1, durationMs: 1, tools: { calls: 0, errors: 0, writes: 0, byTool: {} }, artifactManifest: oversized });
    run.finish("interrupted");
    const saved = store.load(run.runId)!;
    expect(saved).not.toBeNull();
    const evidence = saved.tasks[0]!.result!.artifactManifest!;
    expect(evidence.artifacts.length).toBeLessThan(128);
    expect(evidence.coverage.reasons).toContain("metadata_truncated");
    expect(saved.tasks[0]!.result!.artifactMetadata).toBe("incomplete");
    expect(JSON.stringify(evidence)).not.toContain("private-file-contents");
    expect(JSON.stringify(evidence)).not.toContain("never-record-this-token");
  });

  it.each([false, true])("correlates all same-name provide locations in final dependency and checkpoint evidence (remove second=%s)", async removeSecond => {
    writeFileSync(join(dir, "token-a.js"), "export const SharedToken = 1;");
    writeFileSync(join(dir, "token-b.js"), "export const SharedToken = 1;");
    const d = deps();
    const started: string[] = [];
    d.runTurn = async (session, _brief, options) => {
      const id = (session.metadata as { fusionWorker: { taskId: string } }).fusionWorker.taskId;
      started.push(id);
      if (id === "consumer" && removeSecond) {
        const path = join(dir, "token-b.js");
        unlinkSync(path);
        options.eventHook?.({ type: "llm_event", event: { type: "tool_call_executed", result: { tool: "os.fs.trash", status: "ok", summary: "trashed", details: { path }, truncated: false }, batchIndex: 0, batchSize: 1 } });
      }
      return { session, reason: "reply", stepCount: 1 };
    };
    const tasks = [{ id: "provider", title: "Provider", instructions: "provide SharedToken" }, { id: "consumer", title: "Consumer", instructions: "consume SharedToken" }];
    const result = await buildFusionDelegateTool(d).run({ tasks, contract: {
      provides: [{ task: "provider", kind: "symbol", name: "SharedToken", in: "token-a.js" }, { task: "provider", kind: "symbol", name: "SharedToken", in: "token-b.js" }],
      requires: [{ task: "consumer", name: "SharedToken" }],
    } }, { workingDir: dir, sessionId: "s-parent", stepIndex: 0, signal: new AbortController().signal });
    expect(started).toEqual(["provider", "consumer"]);
    expect((result.details.contract as { findings: { present: boolean }[] }).findings.map(f => f.present)).toEqual([true, !removeSecond]);
    const consumer = (result.details.tasks as WorkerTaskResult[])[1]!;
    const expected = [{ provider: "provider", requirementIndex: 0, status: removeSecond ? "blocked" : "ready" }];
    expect(consumer.artifactManifest!.dependencies).toEqual(expected);
    const store = new FusionRunStore({ dir: join(dir, "checkpoints") });
    const run = store.start({ sessionId: "s-parent", workingDir: dir, args: { tasks }, tasks, waveCount: 2 });
    run.recordTask(consumer);
    run.finish("interrupted");
    expect(store.load(run.runId)!.tasks[1]!.result!.artifactManifest!.dependencies).toEqual(expected);
  });
});
