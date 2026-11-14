import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectTaskArtifactManifests } from "./artifact-manifest-tasks.js";
import type { WorkerTaskResult } from "./worker-result.js";

describe("dependency evidence from runtime release facts", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  it.each([true, false])("requires an actual verified no_changes release (verified=%s)", async verified => {
    const dir = mkdtempSync(join(tmpdir(), "manifest-release-")); dirs.push(dir);
    writeFileSync(join(dir, "core.js"), "export const core = 1;");
    const row = (id: string, status: WorkerTaskResult["status"]): WorkerTaskResult => ({ id, title: id, status, reply: "claimed checked", stepCount: 1, durationMs: 1, tools: { calls: 0, errors: 0, writes: 0, byTool: {} } });
    const rows = await collectTaskArtifactManifests([row("core", "no_changes"), row("ui", "ok")], [{ id: "core", title: "Core", instructions: "provide" }, { id: "ui", title: "UI", instructions: "consume" }], {
      workingDir: dir, roots: [dir], signal: new AbortController().signal,
      contract: { provides: [{ task: "core", kind: "file", name: "core.js" }], requires: [{ task: "ui", name: "core.js" }] }, checkOutcomes: [],
      findings: [{ task: "core", kind: "file", name: "core.js", where: ["core.js"], present: true }],
      ...(verified ? { verifiedNoChangesProviders: new Set(["core"]) } : {}),
    });
    expect(rows[1]!.artifactManifest!.dependencies).toEqual([{ provider: "core", requirementIndex: 0, status: verified ? "ready" : "unknown" }]);
  });
});
