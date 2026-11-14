/** Explicit operator recovery. Loading a journal never authorizes paths outside the selected project. */
import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readlink, realpath, rename, rmdir, stat as followStat, symlink, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { renameWithRetrySync, syncDirectoryBestEffort, writeFileSyncedSync } from "../../config/durable-write.js";

export interface JournalEntry { kind: "file" | "directory" | "symlink"; mode: number; sha256?: string; linkTarget?: string }
export interface PromotionJournalStep {
  path: string; action: "write" | "delete" | "mkdir" | "rmdir";
  status: "intent" | "applied" | "not-applied" | "rolled-back" | "rollback-conflict";
  original: JournalEntry | null; promoted: JournalEntry | null; backup?: string; temp?: string; tempEntry?: JournalEntry;
}
export interface PromotionJournal {
  version: 2; candidate: string; project: string; startedAt: string; ownerPid: number | null;
  checkedWorkspace?: string; recovery?: string;
  retainedStaging?: string[];
  state: "promoting" | "committed" | "rolling-back" | "rolled-back-with-conflicts" | "rolled-back";
  steps: PromotionJournalStep[];
}
export interface RecoveryResult { state: PromotionJournal["state"]; mode: "status" | "dry-run" | "rollback"; ownerAlive: boolean; restored: string[]; planned: string[]; retainedStaging: string[]; conflicts: string[]; steps: number }
const JOURNAL_BYTES = 8 * 1024 * 1024, MAX_STEPS = 100_000, MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const digest = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const allowed = (value: unknown, values: readonly string[]) => typeof value === "string" && values.includes(value);
const pathIdentity = (value: string) => process.platform === "win32" || process.platform === "darwin" ? value.normalize("NFC").toLowerCase() : value;
function fail(message: string): never { throw new Error(`fusion recovery: ${message}`); }
function safePath(value: unknown, operatorState = false): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 32_768 || value.includes("\\")) return false;
  return value.split("/").every(part => part !== "" && part !== "." && part !== ".." &&
    !/[<>:"|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
    (operatorState || !/^\.(?:git|atomic-agent)$/i.test(part)));
}
function entry(value: unknown): value is JournalEntry | null {
  if (value === null) return true;
  if (!record(value) || !allowed(value.kind, ["file", "directory", "symlink"]) || !Number.isInteger(value.mode) || (value.mode as number) < 0 || (value.mode as number) > 0o777) return false;
  if (Object.keys(value).some(key => !["kind", "mode", "sha256", "linkTarget"].includes(key))) return false;
  return value.kind === "file" ? typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256) && value.linkTarget === undefined
    : value.kind === "symlink" ? typeof value.linkTarget === "string" && value.linkTarget.length > 0 && !value.linkTarget.includes("\0") && value.sha256 === undefined
    : value.sha256 === undefined && value.linkTarget === undefined;
}
export function parsePromotionJournal(raw: string): PromotionJournal {
  let value: unknown; try { value = JSON.parse(raw); } catch { return fail("invalid journal JSON"); }
  if (!record(value) || value.version !== 2) return fail("unsupported journal version (old or incomplete journals require manual inspection)");
  if (Object.keys(value).some(key => !["version", "candidate", "project", "startedAt", "ownerPid", "checkedWorkspace", "recovery", "retainedStaging", "state", "steps"].includes(key))) return fail("unknown journal field");
  if (typeof value.candidate !== "string" || !/^candidate-[a-f0-9]{12}$/.test(value.candidate) || typeof value.project !== "string" || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt)) ||
      !(value.ownerPid === null || (Number.isSafeInteger(value.ownerPid) && (value.ownerPid as number) > 0)) ||
      !allowed(value.state, ["promoting", "committed", "rolling-back", "rolled-back-with-conflicts", "rolled-back"]) || !Array.isArray(value.steps) || value.steps.length > MAX_STEPS ||
      (value.checkedWorkspace !== undefined && typeof value.checkedWorkspace !== "string") || (value.recovery !== undefined && typeof value.recovery !== "string")) return fail("invalid journal header");
  const paths = new Set<string>();
  const steps: unknown[] = value.steps;
  for (const step of steps) {
    if (!record(step) || Object.keys(step).some(key => !["path", "action", "status", "original", "promoted", "backup", "temp", "tempEntry"].includes(key)) || !safePath(step.path) ||
        !allowed(step.action, ["write", "delete", "mkdir", "rmdir"]) || !allowed(step.status, ["intent", "applied", "not-applied", "rolled-back", "rollback-conflict"]) || !entry(step.original) || !entry(step.promoted)) return fail("invalid journal step");
    const identity = pathIdentity(step.path);
    if (paths.has(identity)) return fail("duplicate journal path"); paths.add(identity);
    const original = step.original as JournalEntry | null, promoted = step.promoted as JournalEntry | null;
    const action = promoted === null ? original?.kind === "directory" ? "rmdir" : "delete" : promoted.kind === "directory" ? "mkdir" : "write";
    if (step.action !== action || (original === null && promoted === null)) return fail("inconsistent journal action");
    if ((original?.kind === "directory" && promoted !== null) || (promoted?.kind === "directory" && original !== null)) return fail("unsupported directory replacement");
    if (original?.kind === "file") {
      if (typeof step.backup !== "string" || !new RegExp(`^${value.candidate}\\.promotion-backup/[0-9]+$`).test(step.backup)) return fail("invalid backup path");
    } else if (step.backup !== undefined) return fail("unexpected backup");
    if (step.temp !== undefined) {
      if (!safePath(step.temp) || dirname(step.temp) !== dirname(step.path) || !/^\.atag-candidate-[a-f0-9]{16}$/.test(basename(step.temp)) || !entry(step.tempEntry) || step.tempEntry === null || step.tempEntry.kind === "directory") return fail("invalid staging path or identity");
    } else if (step.tempEntry !== undefined) return fail("staging identity without path");
  }
  if (value.retainedStaging !== undefined && (!Array.isArray(value.retainedStaging) || value.retainedStaging.length > MAX_STEPS || value.retainedStaging.some(path => !safePath(path) || !/^\.atag-candidate-[a-f0-9]{16}$/.test(basename(path)) || !steps.some(step => record(step) && typeof step.path === "string" && dirname(step.path) === dirname(path))))) return fail("invalid retained staging paths");
  return value as unknown as PromotionJournal;
}
function alive(pid: number | null): boolean {
  if (pid === null) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
function sameStat(a: Stats | undefined, b: Stats | undefined): boolean {
  return a === undefined || b === undefined ? a === b : a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
async function stat(path: string): Promise<Stats | undefined> {
  try { return await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function parents(root: string, path: string, missing: ReadonlySet<string> = new Set()): Promise<Map<string, Stats>> {
  const result = new Map<string, Stats>();
  const parts: string[] = [];
  for (let part = dirname(path); part !== "."; part = dirname(part)) parts.unshift(part);
  for (const part of [".", ...parts]) {
    const absolute = part === "." ? root : join(root, part), info = await stat(absolute);
    if (info === undefined && missing.has(part.replaceAll("\\", "/"))) return result;
    if (info === undefined) return fail(`missing recovery ancestor: ${path}`);
    if (!info.isDirectory() || info.isSymbolicLink()) return fail(`linked or non-directory ancestor: ${path}`);
    result.set(absolute, info);
  }
  return result;
}
async function checkParents(value: ReadonlyMap<string, Stats>): Promise<void> {
  for (const [path, before] of value) {
    const now = await lstat(path);
    if (!now.isDirectory() || now.isSymbolicLink() || before.dev !== now.dev || before.ino !== now.ino) return fail("ancestor changed during recovery");
  }
}
/** Resolve filesystem names too: NTFS short names are not lexical aliases.
 * Do not resolve a final user symlink's target (unlink/rename acts on the
 * link); compare its identity with protected sibling names instead. */
async function outputScope(root: string, path: string): Promise<void> {
  const parts = path.replaceAll("\\", "/").split("/"); let prefixPath = "";
  for (const [index, part] of parts.entries()) {
    prefixPath = prefixPath === "" ? part : `${prefixPath}/${part}`;
    const absolute = join(root, prefixPath), info = await stat(absolute); if (info === undefined) return;
    if (info.isSymbolicLink() && index === parts.length - 1) {
      for (const protectedName of [".git", ".atomic-agent"]) {
        const protectedInfo = await stat(join(dirname(absolute), protectedName));
        if (protectedInfo !== undefined && info.dev === protectedInfo.dev && info.ino === protectedInfo.ino) return fail("protected symlink reached through an alias");
      }
      continue;
    }
    const canonical = relative(root, await realpath(absolute)).replaceAll("\\", "/");
    if (!safePath(canonical)) return fail("canonical output reaches protected or outside metadata");
    if (pathIdentity(canonical) !== pathIdentity(prefixPath)) return fail("noncanonical filesystem alias in recovery output");
  }
}
async function regularBytes(path: string, maximum: number): Promise<{ bytes: Buffer; info: Stats }> {
  const before = await lstat(path); if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) return fail("unreadable, linked or oversized recovery file");
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameStat(before, await fd.stat())) return fail("recovery file changed before read");
    const bytes = await fd.readFile(); if (bytes.length > maximum || !sameStat(before, await fd.stat()) || !sameStat(before, await lstat(path))) return fail("recovery file changed during read");
    return { bytes, info: before };
  } finally { await fd.close(); }
}
async function fileHash(path: string, destination?: string, mode?: number, signal?: AbortSignal): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) return fail("unreadable, linked or oversized recovery file");
  const source = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const output = destination === undefined ? undefined : await open(destination, "wx", 0o600);
  try {
    if (!sameStat(before, await source.stat())) return fail("recovery file changed before read");
    const hash = createHash("sha256"), chunk = Buffer.alloc(64 * 1024); let total = 0;
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await source.read(chunk, 0, chunk.length, null); if (bytesRead === 0) break;
      total += bytesRead; if (total > MAX_FILE_BYTES) return fail("recovery file byte limit exceeded");
      const bytes = chunk.subarray(0, bytesRead); hash.update(bytes);
      if (output !== undefined) { let offset = 0; while (offset < bytes.length) offset += (await output.write(bytes, offset, bytes.length - offset)).bytesWritten; }
    }
    if (!sameStat(before, await source.stat()) || !sameStat(before, await lstat(path))) return fail("recovery file changed during read");
    if (output !== undefined) { await output.chmod(mode!); await output.sync(); }
    return hash.digest("hex");
  } finally { await output?.close(); await source.close(); }
}
async function observed(root: string, path: string, missing?: ReadonlySet<string>, signal?: AbortSignal): Promise<{ entry: JournalEntry | null; info: Stats | undefined; ancestors: Map<string, Stats> }> {
  await outputScope(root, path);
  const ancestors = await parents(root, path, missing), absolute = join(root, path), info = await stat(absolute);
  if (info === undefined) return { entry: null, info, ancestors };
  const mode = info.mode & 0o777;
  const value: JournalEntry = info.isSymbolicLink() ? { kind: "symlink", mode, linkTarget: await readlink(absolute) }
    : info.isDirectory() ? { kind: "directory", mode }
    : info.isFile() ? { kind: "file", mode, sha256: await fileHash(absolute, undefined, undefined, signal) }
    : fail(`special recovery entry: ${path}`);
  if (!sameStat(info, await lstat(absolute))) return fail(`entry changed while reading: ${path}`);
  return { entry: value, info, ancestors };
}
function equal(a: JournalEntry | null, b: JournalEntry | null): boolean {
  return a === null || b === null ? a === b : a.kind === b.kind && (a.kind === "symlink" || a.mode === b.mode) && a.sha256 === b.sha256 && a.linkTarget === b.linkTarget;
}

/** No automatic caller: only the explicit operator command may invoke rollback. */
export async function recoverPromotion(input: { project: string; journal: string; mode?: RecoveryResult["mode"]; signal?: AbortSignal; afterRestore?: (path: string) => void | Promise<void> }): Promise<RecoveryResult> {
  const deadline = AbortSignal.timeout(120_000), signal = input.signal === undefined ? deadline : AbortSignal.any([input.signal, deadline]);
  signal.throwIfAborted();
  const mode = input.mode ?? "status", root = await realpath(input.project);
  const file = resolve(root, input.journal), rel = relative(root, file).replaceAll("\\", "/");
  if (!/^\.atomic-agent\/fusion-merge\/candidate-[a-f0-9]{12}\.promotion\.json$/.test(rel)) return fail("journal must be in the selected project's fusion-merge directory");
  await parents(root, rel);
  let loaded = await regularBytes(file, JOURNAL_BYTES), journal = parsePromotionJournal(loaded.bytes.toString("utf8"));
  if (journal.project !== root || basename(file) !== `${journal.candidate}.promotion.json`) return fail("journal project or name does not match selected project");
  const result: RecoveryResult = { state: journal.state, mode, ownerAlive: alive(journal.ownerPid), restored: [], planned: [], retainedStaging: [...(journal.retainedStaging ?? [])], conflicts: [], steps: journal.steps.length };
  // A completed recovery is a receipt. Later user edits must never restart it.
  if (journal.state === "rolled-back") return result;
  const missingDirectories = new Set(journal.steps.filter(step =>
    (step.original === null && step.promoted?.kind === "directory") || (step.promoted === null && step.original?.kind === "directory")).map(step => step.path));
  // Preflight every backup and live parent before any mutation (including lock creation).
  for (const step of journal.steps) {
    signal.throwIfAborted();
    if (step.status === "rolled-back" || step.status === "not-applied") continue;
    await outputScope(root, step.path);
    await parents(root, step.path, missingDirectories);
    if (step.backup !== undefined) {
      const backup = join(dirname(file), step.backup); await parents(root, relative(root, backup));
      if (await fileHash(backup, undefined, undefined, signal) !== step.original?.sha256) return fail(`backup hash mismatch: ${step.path}`);
    }
    if (step.temp !== undefined) await parents(root, step.temp, missingDirectories);
  }
  if (mode !== "rollback") {
    const removals = new Set<string>();
    if (mode === "dry-run" && journal.state !== "committed") for (const step of [...journal.steps].reverse()) {
      if (step.status === "rolled-back" || step.status === "not-applied") continue;
      signal.throwIfAborted(); const current = await observed(root, step.path, missingDirectories, signal);
      if (step.temp !== undefined) {
        const staged = await observed(root, step.temp, missingDirectories, signal);
        if (staged.entry !== null && !equal(staged.entry, step.tempEntry!)) result.retainedStaging.push(step.temp);
      }
      if (equal(current.entry, step.original)) continue;
      if (equal(current.entry, step.promoted)) {
        if (step.original === null && current.entry?.kind === "directory" && (await readdir(join(root, step.path))).some(name => !removals.has(pathIdentity(`${step.path}/${name}`)))) {
          result.conflicts.push(step.path); continue;
        }
        result.planned.push(step.path); if (step.original === null) removals.add(pathIdentity(step.path));
      } else result.conflicts.push(step.path);
    }
    return result;
  }
  if (journal.state === "committed") return fail("committed promotion cannot be rolled back");
  if (result.ownerAlive) return fail("journal owner is still alive");
  const lock = `${file}.recovery.lock`;
  // A dead recovery process leaves only a narrowly scoped, validated lock.
  const existing = await stat(lock);
  if (existing !== undefined) {
    const previous = await regularBytes(lock, 1024); let owner: unknown;
    try { owner = JSON.parse(previous.bytes.toString("utf8")); } catch { return fail("invalid recovery lock"); }
    if (!record(owner) || Object.keys(owner).length !== 1 || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0 || alive(owner.pid as number)) return fail("recovery lock is unknown or owned by a live process");
    if (!sameStat(previous.info, await lstat(lock))) return fail("recovery lock changed"); await unlink(lock);
  }
  const lease = await open(lock, "wx", 0o600);
  let leaseIdentity: Stats | undefined;
  try {
    await lease.writeFile(JSON.stringify({ pid: process.pid })); await lease.sync(); leaseIdentity = await lease.stat();
    const refresh = await regularBytes(file, JOURNAL_BYTES);
    if (digest(refresh.bytes) !== digest(loaded.bytes)) return fail("journal changed before recovery"); loaded = refresh;
    const persist = async (): Promise<void> => {
      await parents(root, rel);
      const current = await regularBytes(file, JOURNAL_BYTES);
      if (!sameStat(loaded.info, current.info) || !current.bytes.equals(loaded.bytes)) return fail("journal changed during recovery");
      const temporary = `${file}.recovery-${randomBytes(8).toString("hex")}`;
      writeFileSyncedSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameWithRetrySync(temporary, file); syncDirectoryBestEffort(dirname(file)); loaded = await regularBytes(file, JOURNAL_BYTES);
    };
    journal.state = "rolling-back"; journal.ownerPid = process.pid; await persist();
    const settleTemp = async (step: PromotionJournalStep): Promise<void> => {
      if (step.temp === undefined) return;
      try { await cleanTemp(root, step, missingDirectories); }
      catch {
        // A partial copy or later user edit is not owned just because its
        // random name appears in our journal. Preserve it and use a new temp.
        if (!result.retainedStaging.includes(step.temp)) result.retainedStaging.push(step.temp);
        journal.retainedStaging = [...result.retainedStaging];
      }
    };
    for (const step of [...journal.steps].reverse()) {
      signal.throwIfAborted();
      if (step.status === "rolled-back" || step.status === "not-applied") continue;
      try {
        let current = await observed(root, step.path, missingDirectories, signal);
        if (equal(current.entry, step.original)) {
          step.status = "rolled-back";
        } else if (!equal(current.entry, step.promoted)) {
          step.status = "rollback-conflict"; result.conflicts.push(step.path);
        } else {
          const target = join(root, step.path), original = step.original;
          const guard = async () => { await checkParents(current.ancestors); if (!sameStat(current.info, await stat(target))) return fail(`entry changed before restore: ${step.path}`); };
          if (original === null) {
            await guard(); if (current.entry?.kind === "directory") await rmdir(target); else await unlink(target);
          } else if (original.kind === "directory") {
            if (current.entry !== null) return fail("unsupported directory replacement");
            await guard(); await mkdir(target, { mode: original.mode }); await chmod(target, original.mode);
          } else {
            const temp = join(dirname(step.path), `.atag-candidate-${randomBytes(8).toString("hex")}`).replaceAll("\\", "/");
            // Preserve a previous staging path until its identity has been checked below.
            await settleTemp(step);
            step.temp = temp; step.tempEntry = original; await persist();
            const absolute = join(root, temp);
            if (original.kind === "symlink") {
              const directory = process.platform === "win32" && await followStat(resolve(dirname(absolute), original.linkTarget!)).then(info => info.isDirectory(), () => false);
              await symlink(original.linkTarget!, absolute, directory ? "junction" : undefined);
            }
            else {
              const backup = join(dirname(file), step.backup!); await parents(root, relative(root, backup));
              if (await fileHash(backup, absolute, original.mode, signal) !== original.sha256) return fail(`backup hash mismatch: ${step.path}`);
            }
            const staged = await observed(root, temp, missingDirectories, signal);
            if (!equal(staged.entry, original)) return fail(`staging changed before restore: ${step.path}`);
            await guard(); await checkParents(staged.ancestors);
            if (!sameStat(staged.info, await stat(absolute))) return fail(`staging identity changed before restore: ${step.path}`);
            await rename(absolute, target);
          }
          syncDirectoryBestEffort(dirname(target)); await input.afterRestore?.(step.path);
          current = await observed(root, step.path, missingDirectories, signal);
          if (!equal(current.entry, original)) return fail(`restored entry changed: ${step.path}`);
          step.status = "rolled-back"; result.restored.push(step.path);
        }
        await settleTemp(step);
      } catch { step.status = "rollback-conflict"; if (!result.conflicts.includes(step.path)) result.conflicts.push(step.path); }
      await persist();
    }
    journal.state = result.conflicts.length === 0 ? "rolled-back" : "rolled-back-with-conflicts"; journal.ownerPid = null; await persist();
    result.state = journal.state; result.ownerAlive = false; return result;
  } finally {
    await lease.close();
    if (leaseIdentity !== undefined && sameStat(leaseIdentity, await stat(lock))) await unlink(lock).catch(() => undefined);
  }
}
async function cleanTemp(root: string, step: PromotionJournalStep, missing: ReadonlySet<string>): Promise<void> {
  const current = await observed(root, step.temp!, missing);
  if (current.entry === null) return;
  if (!equal(current.entry, step.tempEntry!)) return fail(`staging path changed: ${step.temp}`);
  await checkParents(current.ancestors);
  if (!sameStat(current.info, await stat(join(root, step.temp!)))) return fail("staging identity changed");
  await unlink(join(root, step.temp!)); syncDirectoryBestEffort(dirname(join(root, step.temp!)));
}
