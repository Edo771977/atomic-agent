import type { DelegateTask } from "./delegate-args.js";
import { provideSearchPaths, type DelegateContract } from "./contract.js";
import type { ContractCheckOutcome, ContractFinding } from "./contract-checks.js";
import type { WorkerTaskResult } from "./worker-result.js";
import { UNTRACKED_WRITE_TOOLS } from "./worker-changes.js";
import { ARTIFACT_MANIFEST_MAX_BYTES, collectArtifactManifest } from "./artifact-manifest.js";
import type { ArtifactManifestCheck, ArtifactManifestDependency, ArtifactManifestReason, ArtifactObservation } from "./artifact-manifest-types.js";
import { resolve } from "node:path";

export interface TaskArtifactManifestContext {
  workingDir: string;
  roots: readonly string[];
  signal: AbortSignal;
  contract?: DelegateContract;
  checkOutcomes: readonly (ContractCheckOutcome | undefined)[];
  findings: readonly ContractFinding[];
}

/** Final facts, not worker claims. One bounded read budget for the entire fan-out. */
export async function collectTaskArtifactManifests(
  rows: readonly WorkerTaskResult[], tasks: readonly DelegateTask[], ctx: TaskArtifactManifestContext,
): Promise<WorkerTaskResult[]> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 2_000);
  timer.unref?.();
  const signal = AbortSignal.any([ctx.signal, deadline.signal]);
  let remaining = ARTIFACT_MANIFEST_MAX_BYTES;
  const out: WorkerTaskResult[] = [];
  try {
    for (const row of rows) {
      const task = tasks.find(t => t.id === row.id);
      const observations: ArtifactObservation[] = [];
      let lostPriorInventory = false;
      for (const change of row.changes ?? []) {
        observations.push({ path: change.path, change: change.kind === "trashed" ? "deleted" : change.kind, source: "file-tool" });
        if (change.movedFrom !== undefined) observations.push({ path: change.movedFrom, change: "deleted", source: "file-tool" });
      }
      for (const prior of row.artifactManifest?.artifacts ?? []) {
        if (prior.path !== null) observations.push({ path: prior.path, change: prior.change, source: prior.source });
        else lostPriorInventory = true;
      }
      for (const path of task?.files ?? []) observations.push({ path, change: "observed", source: "declared" });
      const ownProvides = (ctx.contract?.provides ?? []).filter(p => p.task === row.id);
      let uncheckable = false;
      for (const provide of ownProvides) {
        const paths = provide.kind === "file" ? [provide.name] : provideSearchPaths(provide, ctx.contract!, task);
        if (paths.length === 0) uncheckable = true;
        for (const path of paths) observations.push({ path, change: "observed", source: "provide" });
      }
      const checks: ArtifactManifestCheck[] = [];
      (ctx.contract?.checks ?? []).forEach((check, index) => {
        if (check.task !== undefined && check.task !== row.id) return;
        const outcome = ctx.checkOutcomes[index];
        checks.push({ id: `contract:${index}`, source: "contract", status: outcome === undefined ? "unknown" : outcome.ok ? "pass" : "fail" });
      });
      if (observations.some(o => o.change !== "deleted")) {
        const syntax = row.syntax;
        checks.push({ id: "syntax:0", source: "syntax", status: (syntax?.failedFiles.length ?? 0) > 0 ? "fail" :
          syntax !== undefined && syntax.error === undefined && syntax.checked > 0 && syntax.unchecked === 0 && (syntax.outOfScope ?? 0) === 0 ? "pass" : "unknown" });
      }
      const dependencies: ArtifactManifestDependency[] = [];
      const locationKey = (kind: string, name: string, paths: readonly string[]) => JSON.stringify([kind, name, paths.map(path => {
        const absolute = resolve(ctx.workingDir, path);
        return process.platform === "win32" ? absolute.toLowerCase() : absolute;
      }).sort()]);
      (ctx.contract?.requires ?? []).forEach((requirement, index) => {
        if (requirement.task !== row.id) return;
        const providers = (ctx.contract?.provides ?? []).filter(p => p.name === requirement.name && p.task !== row.id);
        if (providers.length === 0) dependencies.push({ provider: "unprovided", requirementIndex: index, status: "unknown" });
        for (const providerId of new Set(providers.map(p => p.task))) {
          const result = rows.find(r => r.id === providerId);
          const expected = new Map<string, number>();
          for (const provide of providers.filter(p => p.task === providerId)) {
            const paths = provide.kind === "file" ? [provide.name] :
              provideSearchPaths(provide, ctx.contract!, tasks.find(t => t.id === providerId));
            const key = locationKey(provide.kind, provide.name, paths);
            expected.set(key, (expected.get(key) ?? 0) + 1);
          }
          let missing = false;
          let unknown = false;
          for (const [key, count] of expected) {
            const findings = ctx.findings.filter(f => f.task === providerId && locationKey(f.kind, f.name, f.where) === key);
            if (findings.some(f => !f.present)) missing = true;
            if (findings.length < count) unknown = true;
          }
          dependencies.push({ provider: providerId, requirementIndex: index,
            status: result === undefined ? "unknown" : result.status !== "ok" || missing ? "blocked" : unknown ? "unknown" : "ready" });
        }
      });
      const incomplete: ArtifactManifestReason[] = [];
      if (lostPriorInventory || row.artifactManifest?.coverage.reasons.includes("metadata_truncated")) incomplete.push("metadata_truncated");
      if (row.shellRan === true || Object.keys(row.tools.byTool).some(tool => UNTRACKED_WRITE_TOOLS.has(tool))) incomplete.push("untracked_writes");
      if (uncheckable) incomplete.push("verification_unknown");
      if (row.artifactManifest === undefined && observations.length === 0 && checks.length === 0 && dependencies.length === 0 && incomplete.length === 0) { out.push(row); continue; }
      const artifactManifest = await collectArtifactManifest({ workingDir: ctx.workingDir, roots: ctx.roots, signal, artifacts: observations, checks, dependencies, incomplete, coverage: "observed", limits: { bytes: remaining } });
      remaining -= artifactManifest.bytesHashed;
      out.push({ ...row, artifactManifest });
    }
    return out;
  } finally { clearTimeout(timer); }
}
