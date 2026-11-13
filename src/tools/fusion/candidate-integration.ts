import { createHash, randomBytes } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { chmod, copyFile, lstat, mkdir, opendir, readlink, rename, rm, rmdir, symlink } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { isInside } from "../../approval/fanout-scope.js";
import { resolveUserPath } from "../os/expand-home.js";
import { inputPathIdentity } from "../os/fs/fs-input-path-identity.js";
import { VERIFY_COPY_EXCLUDED, VERIFY_COPY_MAX_BYTES } from "../verify/verify-workspace-copy.js";
import { createBranchSet, defaultGitExec, BRANCH_MERGE_DIR, ensureMergeDir, type BranchSet, type BranchWorkspace, type CreateBranchSetOptions, type GitExec } from "./branch-workspace.js";
import { workspaceChanges, writeTaskPatch, type SavedTaskPatch } from "./branch-diff.js";
import { resolveContractInputs } from "./contract-inputs.js";
import { inspectContractProvides, runContractChecks, type ContractCheckRunner, type ContractReport } from "./contract-checks.js";
import type { DelegateContract } from "./contract.js";
import type { DelegateTask } from "./delegate-args.js";
import type { WorkerTaskResult } from "./worker-result.js";
import { collectArtifactManifest } from "./artifact-manifest.js";
import type { ArtifactManifest, ArtifactManifestDependency, ArtifactObservation } from "./artifact-manifest-types.js";

interface Entry { kind: "file" | "symlink" | "directory"; mode: number; hash?: string }
type Inventory = Map<string, Entry>;
const equal = (a: Entry | undefined, b: Entry | undefined): boolean =>
  a === undefined || b === undefined ? a === b : a.kind === b.kind && a.mode === b.mode && a.hash === b.hash;
const depth = (path: string): number => path.split(sep).length;

/** A strict, byte-based inventory: never follow links or trust size/mtime cache hints. */
interface InventoryBounds { bytes: number; entries: number; signal?: AbortSignal }
async function lineCount(path: string, signal: AbortSignal): Promise<number> {
  let lines = 0, last: number | undefined;
  let left = VERIFY_COPY_MAX_BYTES;
  for await (const chunk of createReadStream(path, { signal, highWaterMark: 64 * 1024 })) {
    signal.throwIfAborted(); const bytes = chunk as Buffer; left -= bytes.length;
    if (left < 0) throw new Error("declared input byte limit exceeded");
    for (const byte of bytes) if (byte === 10) lines += 1;
    last = bytes.at(-1);
  }
  return last === undefined || last === 10 ? lines : lines + 1;
}
async function fileHash(path: string, bounds: InventoryBounds): Promise<string> {
  bounds.signal?.throwIfAborted();
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024, ...(bounds.signal === undefined ? {} : { signal: bounds.signal }) })) {
    bounds.signal?.throwIfAborted();
    bounds.bytes -= (chunk as Buffer).length;
    if (bounds.bytes < 0) throw new Error("candidate inventory byte limit exceeded");
    hash.update(chunk);
  }
  return hash.digest("hex");
}
/**
 * Tracked paths of the snapshot and every ancestor directory. Git ignore
 * rules and the dependency/build folder names never apply to these: the
 * candidate copy carries every tracked file, so promotion must too.
 */
async function trackedPaths(set: BranchSet, git: GitExec): Promise<ReadonlySet<string>> {
  if (set.method !== "worktree") return new Set();
  const listed = await git(["ls-files", "--cached", "-z"], set.baseDir);
  if (listed === null || listed.exitCode !== 0 || listed.timedOut || listed.truncated) throw new Error("Git could not list the candidate's tracked paths");
  const out = new Set<string>();
  for (const path of listed.stdout.split("\0").filter(Boolean)) {
    for (let entry = path.split("/").join(sep); entry !== "." && !out.has(entry); entry = dirname(entry)) out.add(entry);
  }
  return out;
}
/** The project's own agent state (approval rules, merge artifacts): never promoted from a candidate. */
const AGENT_STATE_DIR = dirname(BRANCH_MERGE_DIR);
const isAgentState = (rel: string): boolean => rel === AGENT_STATE_DIR || rel.startsWith(`${AGENT_STATE_DIR}${sep}`);
async function inventory(root: string, workspace: BranchWorkspace, tracked: ReadonlySet<string>, bounds: InventoryBounds): Promise<Inventory> {
  const out: Inventory = new Map();
  const leaves: { rel: string; info: Stats }[] = [];
  const walk = async (dir: string): Promise<void> => {
    bounds.signal?.throwIfAborted();
    const entries = [];
    for await (const entry of await opendir(join(root, dir))) {
      bounds.signal?.throwIfAborted();
      if (entries.length >= bounds.entries) throw new Error("candidate inventory entry limit exceeded");
      entries.push(entry);
    }
    const dirs = entries.filter(e => e.isDirectory()).map(e => join(dir, e.name));
    const ignored = await workspace.directoryIgnorePolicy?.(dirs, bounds.signal);
    for (const item of entries) {
      const rel = join(dir, item.name);
      if (item.name === ".git" || rel === BRANCH_MERGE_DIR || rel.startsWith(`${BRANCH_MERGE_DIR}${sep}`)) continue;
      // Disposable dependency/build/ignored folders, unless they hold tracked paths.
      if ((VERIFY_COPY_EXCLUDED.has(item.name) || workspace.excludedDirectories?.has(rel) || ignored?.has(rel)) && !tracked.has(rel)) continue;
      bounds.signal?.throwIfAborted();
      if (--bounds.entries < 0) throw new Error("candidate inventory entry limit exceeded");
      const info = await lstat(join(root, rel));
      if (info.isDirectory()) {
        // The state folder itself may appear only to hold merge artifacts; its contents are inventoried.
        if (rel !== AGENT_STATE_DIR) out.set(rel, { kind: "directory", mode: info.mode & 0o777 });
        await walk(rel);
      } else if (info.isSymbolicLink() || info.isFile()) leaves.push({ rel, info });
      else throw new Error(`unsupported candidate entry: ${rel}`);
    }
  };
  await walk("");
  // Ignored standalone files (.env, logs) are private to the candidate: never
  // compared or promoted. Ignore rules never apply to tracked paths.
  const untracked = leaves.filter(leaf => !tracked.has(leaf.rel)).map(leaf => leaf.rel);
  const ignoredFiles = untracked.length === 0 ? undefined : await workspace.directoryIgnorePolicy?.(untracked, bounds.signal);
  for (const { rel, info } of leaves) {
    if (ignoredFiles?.has(rel) === true) continue;
    bounds.signal?.throwIfAborted();
    const path = join(root, rel);
    if (info.isSymbolicLink()) { out.set(rel, { kind: "symlink", mode: 0, hash: createHash("sha256").update(await readlink(path)).digest("hex") }); continue; }
    if (info.size > bounds.bytes) throw new Error("candidate inventory byte limit exceeded");
    const hash = await fileHash(path, bounds); const after = await lstat(path);
    if (!after.isFile() || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error(`file changed while snapshotting: ${rel}`);
    out.set(rel, { kind: "file", mode: info.mode & 0o777, hash });
  }
  return out;
}
function differences(a: Inventory, b: Inventory): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].filter(path => !equal(a.get(path), b.get(path))).sort();
}

export interface CandidateIntegrationReport {
  status: "promoted" | "rejected";
  nonResumable: true;
  reason?: string;
  patch?: SavedTaskPatch;
  /** Relative paths from the authoritative final snapshot; disposable directories excluded. */
  changes: string[];
  contract?: ContractReport;
  /** Concurrent edits prevent rollback of these paths; their current bytes were preserved. */
  rollbackConflicts?: string[];
  /** Recovery fallback if a bounded patch cannot be made; cleanup leaves this private workspace intact. */
  retainedWorkspace?: string;
  heldArtifactsDir?: string;
  /** Bounded receipt; its explicit incomplete coverage does not replace the complete transaction inventory. */
  artifactManifest?: ArtifactManifest;
}
export interface CandidateFinishInput {
  rows: readonly WorkerTaskResult[];
  tasks?: readonly DelegateTask[];
  contract?: DelegateContract;
  runChecks?: ContractCheckRunner;
  signal: AbortSignal;
}
export interface CandidateIntegration {
  dir: string;
  finish(input: CandidateFinishInput): Promise<CandidateIntegrationReport>;
  reject(reason: string): Promise<CandidateIntegrationReport>;
  cleanup(): Promise<void>;
}

/**
 * One private candidate for a complete fan-out. Promotion is a guarded file
 * transaction, not OS process confinement or an atomic multi-file visibility claim.
 */
export async function createCandidateIntegration(
  realDir: string,
  options: CreateBranchSetOptions & { beforeApply?: (path: string, index: number) => Promise<void>; maxInventoryBytes?: number; maxInventoryEntries?: number; maxInventoryMs?: number } = {},
): Promise<CandidateIntegration> {
  const id = `candidate-${randomBytes(6).toString("hex")}`;
  const setupSignal = options.signal === undefined ? AbortSignal.timeout(120_000) : AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]);
  const set = await createBranchSet(realDir, [id], { ...options, signal: setupSignal, privateDependencyDirectories: true });
  if (set === null) throw new Error("candidate workspace unavailable: private copies exceed the copy limit");
  const workspace = set.workspaces.get(id)!;
  let tracked: ReadonlySet<string>;
  try { tracked = await trackedPaths(set, options.git ?? defaultGitExec); } catch (err) { await set.cleanup(); throw err; }
  const snapshot = (root: string, signal?: AbortSignal): Promise<Inventory> => inventory(root, workspace, tracked, { bytes: options.maxInventoryBytes ?? options.maxCopyBytes ?? VERIFY_COPY_MAX_BYTES, entries: options.maxInventoryEntries ?? 100_000, signal: signal === undefined ? AbortSignal.timeout(options.maxInventoryMs ?? 30_000) : AbortSignal.any([signal, AbortSignal.timeout(options.maxInventoryMs ?? 30_000)]) });
  let retain = false;
  let base: Inventory;
  try {
    base = await snapshot(set.baseDir, setupSignal);
    if (differences(base, await snapshot(set.realDir, setupSignal)).length > 0) throw new Error("original project changed while creating candidate");
    // A hard process stop cannot write a patch. Normal completion cleans
    // this marker; a stale sweep must preserve the only recovery copy.
    await set.retainForRecovery?.();
  } catch (err) { await set.cleanup(); throw err; }
  // Force byte comparison for every entry, including equal-size/restored-mtime writes.
  const diffWorkspace: BranchWorkspace = { ...workspace, manifest: new Map([...workspace.manifest].map(([path, stamp]) => [path, { ...stamp, size: -1 }])) };
  let heldArtifactsDir: string | undefined;
  const preserveHeldArtifacts = async (signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    if (heldArtifactsDir !== undefined) return;
    const source = join(workspace.dir, BRANCH_MERGE_DIR);
    const info = await lstat(source).catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return null; throw err; });
    if (info === null) return;
    if (!info.isDirectory()) throw new Error("inner recovery artifact folder is not a directory");
    const destination = join(await ensureMergeDir(set.realDir), `${id}.held`);
    await mkdir(destination);
    const bounds: InventoryBounds = { bytes: options.maxCopyBytes ?? VERIFY_COPY_MAX_BYTES, entries: 100_000, signal: signal ?? AbortSignal.timeout(30_000) };
    const copy = async (from: string, to: string): Promise<void> => {
      bounds.signal?.throwIfAborted(); if (--bounds.entries < 0) throw new Error("held artifact entry limit exceeded");
      const entry = await lstat(from);
      if (entry.isDirectory()) { await mkdir(to); for await (const child of await opendir(from)) await copy(join(from, child.name), join(to, child.name)); }
      else if (entry.isSymbolicLink()) await symlink(await readlink(from), to);
      else if (entry.isFile()) { bounds.bytes -= entry.size; if (bounds.bytes < 0) throw new Error("held artifact byte limit exceeded"); await copyFile(from, to); await chmod(to, entry.mode & 0o777); }
      else throw new Error("unsupported held artifact kind");
    };
    for await (const entry of await opendir(source)) await copy(join(source, entry.name), join(destination, entry.name));
    heldArtifactsDir = relative(set.realDir, destination);
  };
  const reject = async (reason: string, report: Partial<CandidateIntegrationReport> = {}): Promise<CandidateIntegrationReport> => {
    try {
      // The caller may already be cancelled: recovery gets one independent,
      // bounded opportunity to save changes, then retains the workspace.
      const recoverySignal = AbortSignal.timeout(30_000);
      await snapshot(workspace.dir, recoverySignal);
      await preserveHeldArtifacts(recoverySignal);
      const changes = await workspaceChanges(set, diffWorkspace, undefined, recoverySignal);
      const patch = await writeTaskPatch({ realDir: set.realDir, set, workspace: diffWorkspace, taskId: id, changes, signal: recoverySignal });
      return { status: "rejected", nonResumable: true, reason, changes: changes.map(c => c.path), patch, ...(heldArtifactsDir === undefined ? {} : { heldArtifactsDir }), ...report };
    } catch (err) {
      retain = true;
      await set.retainForRecovery?.();
      return { status: "rejected", nonResumable: true, reason: `${reason}; patch unavailable: ${err instanceof Error ? err.message : String(err)}; private workspace retained for recovery`, changes: [], retainedWorkspace: workspace.dir, ...(heldArtifactsDir === undefined ? {} : { heldArtifactsDir }), ...report };
    }
  };

  // Same-directory rename never writes through an existing symlink. A fresh
  // ancestor scan also refuses a parent replaced with a link during delivery.
  const writeEntry = async (root: string, rel: string, expected: Entry | undefined): Promise<void> => {
    const target = join(set.realDir, rel);
    for (let parent = dirname(rel); parent !== "."; parent = dirname(parent)) {
      const info = await lstat(join(set.realDir, parent));
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`delivery parent is no longer a directory: ${parent}`);
    }
    if (expected === undefined) { await rm(target); return; }
    if (expected.kind === "directory") { await mkdir(target); await chmod(target, expected.mode); return; }
    const tmp = join(dirname(target), `.atag-candidate-${randomBytes(8).toString("hex")}`);
    try {
      if (expected.kind === "symlink") {
        const link = await readlink(join(root, rel));
        if (createHash("sha256").update(link).digest("hex") !== expected.hash) throw new Error(`candidate changed before delivery: ${rel}`);
        await symlink(link, tmp);
      } else {
        await copyFile(join(root, rel), tmp);
        if (await fileHash(tmp, { bytes: options.maxInventoryBytes ?? VERIFY_COPY_MAX_BYTES, entries: 1, signal: AbortSignal.timeout(30_000) }) !== expected.hash) throw new Error(`candidate changed before delivery: ${rel}`);
        await chmod(tmp, expected.mode);
      }
      await rename(tmp, target);
    } finally { await rm(tmp, { force: true }); }
  };

  return {
    dir: workspace.dir, cleanup: () => retain ? Promise.resolve() : set.cleanup(), reject,
    async finish(input) {
      let evidence: ContractReport | undefined;
      const applied: string[] = []; const rollbackConflicts: string[] = [];
      let final: Inventory | undefined;
      let artifactManifest: ArtifactManifest | undefined;
      try {
        input.signal.throwIfAborted();
        if (input.rows.length === 0 || input.rows.some(row => row.status !== "ok") || input.tasks?.some(task => !input.rows.some(row => row.id === task.id))) return await reject("candidate not promoted: every task must close with status ok");
        const checks = input.contract?.checks ?? [];
        if (checks.length === 0) return await reject("candidate not promoted: at least one explicit contract integration check is required");
        // Always rerun ALL declared checks on the final candidate, even when
        // a task's earlier isolated gate or dependency release passed them.
        const runner: ContractCheckRunner | undefined = input.runChecks === undefined ? undefined : async (specs, ctx) => {
          const result = await input.runChecks!(specs, ctx);
          return result.ok ? result : { ok: false, results: result.results.map(row => ({ ...row, ok: false })) };
        };
        const checked = await runContractChecks(checks, runner, { workingDir: workspace.dir, signal: input.signal });
        input.signal.throwIfAborted();
        const provides = await inspectContractProvides(input.contract!, input.tasks ?? [], workspace.dir, { results: [...input.rows], signal: input.signal });
        evidence = { ...provides, checks: checked.outcomes, ...(checked.checksSkipped === undefined ? {} : { checksSkipped: checked.checksSkipped }) };
        if (checked.checksSkipped !== undefined || checked.outcomes.length !== checks.length || checked.outcomes.some(check => !check.ok)) return await reject("candidate not promoted: final integration checks failed or could not be verified", { contract: evidence });
        if (provides.providesSkipped !== undefined || provides.findings.some(finding => !finding.present) || provides.findings.length !== (input.contract?.provides?.length ?? 0)) return await reject("candidate not promoted: declared provides are missing or uninspectable", { contract: evidence });
        input.signal.throwIfAborted();
        final = await snapshot(workspace.dir, input.signal);
        const changed = differences(base, final);
        // Approval rules and other project agent state are operator-owned: a
        // worker cannot loosen or remove them by way of a promoted candidate.
        const agentState = changed.filter(isAgentState);
        if (agentState.length > 0) return await reject(`candidate not promoted: it changes the project's agent state directory ${AGENT_STATE_DIR}/ (${agentState.map(p => p.split(sep).join("/")).join(", ")}); only the operator may change it`, { contract: evidence });
        const artifacts: ArtifactObservation[] = changed.map(path => ({ path, source: "snapshot", change: !final!.has(path) ? "deleted" : !base.has(path) ? "new" : base.get(path)?.hash === final!.get(path)?.hash ? "mode" : "modified" }));
        const dependencies = (input.contract?.requires ?? []).flatMap<ArtifactManifestDependency>((requirement, requirementIndex) => {
          const providers = (input.contract?.provides ?? []).filter(provide => provide.name === requirement.name && provide.task !== requirement.task);
          return providers.length === 0 ? [{ provider: "external", requirementIndex, status: "unknown" as const }] : providers.map(provide => ({ provider: provide.task, requirementIndex, status: "ready" as const }));
        });
        artifactManifest = await collectArtifactManifest({ workingDir: workspace.dir, roots: [workspace.dir], artifacts, dependencies, checks: checked.outcomes.map((check, index) => ({ id: `contract:${index}`, source: "contract", status: check.ok ? "pass" : "fail" })), signal: input.signal, coverage: "snapshot" });
        input.signal.throwIfAborted();
        if (differences(final, await snapshot(workspace.dir, input.signal)).length > 0) throw new Error("candidate changed during final evidence collection");
        // No untested three-way merge. Even unrelated new user paths change
        // the tested project state and hold the entire candidate back.
        if (differences(base, await snapshot(set.realDir, input.signal)).length > 0) return await reject("candidate not promoted: original project changed since its snapshot", { contract: evidence });
        // The delegate rebases absolute inputs into the candidate. Restore
        // their original identity before comparing final delivery paths;
        // relative and already-original absolute helper inputs stay guarded too.
        const inputs = new Set((input.contract?.inputs ?? []).flatMap(inputPath => {
          let path: string;
          try { path = resolveUserPath(inputPath, workspace.dir); } catch { return []; }
          const root = isInside(workspace.dir, path) ? workspace.dir : isInside(set.realDir, path) ? set.realDir : undefined;
          // Temp/project ancestors can contain literal glob characters. Only
          // the user-declared suffix is a pattern, never an injected prefix.
          return root === undefined ? resolveContractInputs([inputPath], workspace.dir)
            : resolveContractInputs([relative(root, path)], set.realDir);
        }).map(path => inputPathIdentity(path)));
        for (const path of changed) {
          const before = base.get(path), after = final.get(path);
          if (before?.kind === "directory" && after !== undefined && after.kind !== "directory" || after?.kind === "directory" && before !== undefined && before.kind !== "directory") throw new Error(`directory type replacement requires orchestrator review: ${path}`);
          if (before?.kind === "directory" && after?.kind === "directory" && before.mode !== after.mode) throw new Error(`directory mode replacement requires orchestrator review: ${path}`);
          if (inputs.has(inputPathIdentity(join(set.realDir, path)))) {
            if (before !== undefined && after === undefined) throw new Error(`declared input ${path}: would remove the user's file`);
            if (before?.kind === "file") {
              if (after?.kind !== "file") throw new Error(`declared input ${path}: would remove the user's file`);
              const beforeLines = await lineCount(join(set.baseDir, path), input.signal), afterLines = await lineCount(join(workspace.dir, path), input.signal);
              if (beforeLines >= 4 && afterLines * 2 < beforeLines) throw new Error(`declared input ${path}: would replace the user's file (${beforeLines} → ${afterLines} lines)`);
            }
          }
        }
        const additions = changed.filter(p => final!.get(p)?.kind === "directory" && !base.has(p)).sort((a, b) => depth(a) - depth(b));
        const files = changed.filter(p => (final!.get(p) ?? base.get(p))?.kind !== "directory");
        const removals = changed.filter(p => base.get(p)?.kind === "directory" && !final!.has(p)).sort((a, b) => depth(b) - depth(a));
        const promotionSignal = AbortSignal.any([input.signal, AbortSignal.timeout(120_000)]);
        for (const [index, path] of [...additions, ...files, ...removals].entries()) {
          promotionSignal.throwIfAborted(); await options.beforeApply?.(path, index); promotionSignal.throwIfAborted();
          // Check the whole current state before each write, accounting only
          // for our already-applied paths. Refuse concurrent user changes.
          const expected = new Map(base); for (const appliedPath of applied) { const entry = final.get(appliedPath); if (entry === undefined) expected.delete(appliedPath); else expected.set(appliedPath, entry); }
          if (differences(expected, await snapshot(set.realDir, promotionSignal)).length > 0) throw new Error("original project changed during candidate delivery");
          if (base.get(path)?.kind === "directory" && !final.has(path)) await rmdir(join(set.realDir, path));
          else await writeEntry(workspace.dir, path, final.get(path));
          applied.push(path);
        }
        promotionSignal.throwIfAborted();
        if (differences(final, await snapshot(set.realDir, promotionSignal)).length > 0) throw new Error("original project changed while completing candidate delivery");
        return { status: "promoted", nonResumable: true, changes: changed.map(p => p.split(sep).join("/")), contract: evidence, artifactManifest };
      } catch (err) {
        // Roll back only bytes we still own. If a user edited a delivered
        // path, retain that edit and report it instead of overwriting it.
        for (const path of applied.reverse()) {
          try {
            const current = await snapshot(set.realDir);
            if (!equal(current.get(path), final?.get(path))) { rollbackConflicts.push(path); continue; }
            if (final?.get(path)?.kind === "directory" && !base.has(path)) await rmdir(join(set.realDir, path));
            else await writeEntry(set.baseDir, path, base.get(path));
          } catch { rollbackConflicts.push(path); }
        }
        return await reject(`candidate not promoted: ${err instanceof Error ? err.message : String(err)}`, { ...(evidence === undefined ? {} : { contract: evidence }), ...(artifactManifest === undefined ? {} : { artifactManifest }), ...(rollbackConflicts.length === 0 ? {} : { rollbackConflicts }) });
      }
    },
  };
}
