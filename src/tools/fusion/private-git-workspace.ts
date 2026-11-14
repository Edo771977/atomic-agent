/** Independent Git stores. Only object data, refs and shallow boundaries cross the source boundary. */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, createWriteStream, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createDeflate } from "node:zlib";
import { buildCommandEnv } from "../../sandbox/command-env.js";
import { runCommand } from "../../sandbox/command-runner.js";
import { killProcessTree } from "../../sandbox/kill-process-tree.js";
import { DEFAULT_VERIFY_MAX_GIT_OBJECT_BYTES } from "../../config/tool-config.js";

const MAX_OBJECTS = 100_000, MAX_OUTPUT = 32 * 1024 * 1024;
export const DEFAULT_GIT_OBJECT_BYTES = DEFAULT_VERIFY_MAX_GIT_OBJECT_BYTES;
export interface GitObjectBudget { left: number; signal?: AbortSignal }
interface Ref { name: string; oid: string; symbolic?: string }
export interface PrivateGitSnapshot { seed: string; commit: string; refs: readonly Ref[]; shallow: string; format: string; emptyConfig: string; infoExclude: Buffer; globalExclude: Buffer; trackedPaths: string[]; untracked: string[]; ignored: string[]; unmerged: boolean; budget: GitObjectBudget }
function charge(budget: GitObjectBudget, bytes: number): void {
  budget.signal?.throwIfAborted(); budget.left -= bytes;
  if (budget.left < 0) throw new Error("Git object import exceeds tools.verify.maxGitObjectBytes limit");
}
const env = (emptyConfig: string): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(buildCommandEnv(process.env)).filter(([name]) => !/^GIT_/i.test(name))),
  GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: "",
  GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "", LC_ALL: "C",
  GIT_AUTHOR_NAME: "Fusion snapshot", GIT_AUTHOR_EMAIL: "fusion@localhost", GIT_COMMITTER_NAME: "Fusion snapshot", GIT_COMMITTER_EMAIL: "fusion@localhost",
});
const prefix = ["--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false"];
async function git(args: string[], cwd: string, snapshot: Pick<PrivateGitSnapshot, "emptyConfig" | "budget">, input?: string): Promise<string> {
  snapshot.budget.signal?.throwIfAborted();
  const result = await runCommand("git", [...prefix, ...args], { cwd, env: env(snapshot.emptyConfig), input, timeoutMs: 120_000, maxOutputBytes: MAX_OUTPUT, ...(snapshot.budget.signal === undefined ? {} : { signal: snapshot.budget.signal }) });
  snapshot.budget.signal?.throwIfAborted();
  if (result.exitCode !== 0 || result.timedOut || result.truncated || result.inputTruncated) throw new Error(`private Git ${args[0]} failed: ${result.stderr.trim() || "incomplete result"}`);
  return result.stdout;
}
async function objects(source: string, tips: string[], snapshot: PrivateGitSnapshot): Promise<string[]> {
  const output = await git(["rev-list", "--objects", "--no-object-names", "--stdin"], source, snapshot, `${tips.join("\n")}\n`);
  const ids = [...new Set(output.trim().split("\n").filter(Boolean))];
  const oid = snapshot.format === "sha256" ? /^[a-f0-9]{64}$/ : /^[a-f0-9]{40}$/;
  if (ids.length > MAX_OBJECTS || ids.some(value => !oid.test(value))) throw new Error("Git object import exceeds the 100000 object limit or has invalid object IDs");
  const sizes = await git(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], source, snapshot, `${ids.join("\n")}\n`);
  const lines = sizes.trim().split("\n"); if (lines.length !== ids.length) throw new Error("incomplete Git object inventory");
  let bytes = 0;
  for (const [index, line] of lines.entries()) {
    const match = /^([a-f0-9]+) (blob|tree|commit|tag) ([0-9]+)$/.exec(line);
    if (match === null || match[1] !== ids[index] || !Number.isSafeInteger(Number(match[3]))) throw new Error("invalid Git object inventory");
    bytes += Number(match[3]); if (!Number.isSafeInteger(bytes) || bytes > snapshot.budget.left) throw new Error("Git object import exceeds tools.verify.maxGitObjectBytes limit");
  }
  charge(snapshot.budget, bytes); return ids;
}
async function importObjects(source: string, destination: string, tips: string[], snapshot: PrivateGitSnapshot): Promise<void> {
  const ids = await objects(source, tips, snapshot);
  const options = { env: env(snapshot.emptyConfig), windowsHide: true, stdio: "pipe" as const };
  const producer = spawn("git", [...prefix, "pack-objects", "--stdout", "--threads=1", "--window=0"], { ...options, cwd: source });
  const consumer = spawn("git", [...prefix, "index-pack", "--stdin"], { ...options, cwd: destination });
  const children = [producer, consumer];
  let error: Error | undefined;
  const stop = (reason: unknown): void => {
    error ??= reason instanceof Error ? reason : new Error(String(reason));
    for (const child of children) if (child.exitCode === null) killProcessTree(child, { force: true });
  };
  const timer = setTimeout(() => stop(new Error("Git object import timed out")), 120_000);
  const abort = () => stop(snapshot.budget.signal?.reason ?? new Error("Git object import cancelled"));
  snapshot.budget.signal?.addEventListener("abort", abort, { once: true });
  const complete = children.map(child => new Promise<void>((resolveDone, reject) => {
    child.on("error", reason => { stop(reason); reject(reason); });
    child.on("close", code => { if (code === 0) resolveDone(); else { const reason = error ?? new Error(`Git object import child exited ${code}`); stop(reason); reject(reason); } });
    let diagnostics = 0;
    child.stderr.on("data", (chunk: Buffer) => { diagnostics += chunk.length; if (diagnostics > MAX_OUTPUT) stop(new Error("Git object import diagnostic limit exceeded")); });
    child.stdout.on("error", stop); child.stdin.on("error", stop);
  }));
  // index-pack's only stdout is a small pack identifier; always drain it.
  consumer.stdout.resume();
  const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) { try { charge(snapshot.budget, chunk.length); callback(null, chunk); } catch (reason) { stop(reason); callback(reason as Error); } } });
  try {
    snapshot.budget.signal?.throwIfAborted();
    producer.stdin.end(`${ids.join("\n")}\n`);
    await Promise.all([...complete, pipeline(producer.stdout, bounded, consumer.stdin)]);
    if (error !== undefined) throw error;
  } catch (reason) { stop(reason); await Promise.allSettled(complete); throw error ?? reason; }
  finally { clearTimeout(timer); snapshot.budget.signal?.removeEventListener("abort", abort); }
}
async function initialize(destination: string, snapshot: PrivateGitSnapshot, bare: boolean): Promise<void> {
  await mkdir(destination, { recursive: true });
  await git(["init", "-q", "--template=", ...(bare ? ["--bare"] : []), `--object-format=${snapshot.format}`, destination], destination, snapshot);
}
async function installMetadata(destination: string, snapshot: PrivateGitSnapshot, bare: boolean): Promise<void> {
  const metadata = bare ? destination : join(destination, ".git");
  await mkdir(join(metadata, "info"), { recursive: true });
  charge(snapshot.budget, snapshot.infoExclude.length + snapshot.globalExclude.length);
  await writeFile(join(metadata, "info", "exclude"), snapshot.infoExclude);
  const globalFile = join(metadata, "global-excludes"); await writeFile(globalFile, snapshot.globalExclude);
  await git(["config", "--local", "core.excludesFile", globalFile], destination, snapshot);
  if (snapshot.shallow !== "") await writeFile(join(metadata, "shallow"), snapshot.shallow);
  const direct = snapshot.refs.filter(ref => ref.symbolic === undefined);
  if (direct.length > 0) await git(["update-ref", "--stdin"], destination, snapshot, direct.map(ref => `update ${ref.name} ${ref.oid}\n`).join(""));
  for (const ref of snapshot.refs) if (ref.symbolic !== undefined) await git(["symbolic-ref", ref.name, ref.symbolic], destination, snapshot);
  await writeFile(join(metadata, "HEAD"), `${snapshot.commit}\n`);
}
function sameFile(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
async function freezeRule(path: string, snapshot: PrivateGitSnapshot): Promise<Buffer> {
  let canonical: string;
  try { canonical = await realpath(path); } catch (reason) { if ((reason as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0); throw reason; }
  const before = await lstat(canonical);
  if (!before.isFile() || before.size > 8 * 1024 * 1024) throw new Error("private Git ignore rule exceeds the 8 MiB file limit");
  charge(snapshot.budget, before.size);
  const fd = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameFile(before, await fd.stat())) throw new Error("Git ignore rule changed before snapshot");
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      snapshot.budget.signal?.throwIfAborted();
      const read = await fd.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw new Error("Git ignore rule changed during snapshot"); offset += read.bytesRead;
    }
    if (!sameFile(before, await fd.stat()) || !sameFile(before, await lstat(canonical)) || await realpath(path) !== canonical) throw new Error("Git ignore rule changed during snapshot");
    return bytes;
  } finally { await fd.close(); }
}
/** Reading a split index with Git can freshen source sharedindex mtimes even
 * with optional locks disabled. Copy index data first; every index consumer
 * then operates inside the private Git directory. */
async function copyIndexFile(source: string, destination: string, snapshot: PrivateGitSnapshot): Promise<void> {
  const before = await lstat(source);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("source Git index metadata is not a regular file");
  charge(snapshot.budget, before.size);
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!sameFile(before, await input.stat())) throw new Error("source Git index metadata changed before copying");
    output = await open(destination, "wx", 0o600);
    let offset = 0;
    while (offset < before.size) {
      snapshot.budget.signal?.throwIfAborted();
      const chunk = Buffer.alloc(Math.min(64 * 1024, before.size - offset)), read = await input.read(chunk, 0, chunk.length, offset);
      if (read.bytesRead === 0) throw new Error("source Git index metadata changed while copying");
      let written = 0; while (written < read.bytesRead) written += (await output.write(chunk, written, read.bytesRead - written)).bytesWritten;
      offset += read.bytesRead;
    }
    if (!sameFile(before, await input.stat()) || !sameFile(before, await lstat(source))) throw new Error("source Git index metadata changed while copying");
  } finally { await output?.close(); await input.close(); }
}
function finishPreparation(snapshot: PrivateGitSnapshot, callerSignal: AbortSignal | undefined): PrivateGitSnapshot {
  snapshot.budget.signal?.throwIfAborted();
  if (callerSignal === undefined) delete snapshot.budget.signal; else snapshot.budget.signal = callerSignal;
  return snapshot;
}
/** Git loose-object encoding, from a pinned descriptor and an exact bounded read.
 * Unlike hash-object <path>, a growing source cannot write an oversized object
 * before our byte guard observes it. There are no clean/smudge filters here. */
async function writeBlob(path: string, snapshot: PrivateGitSnapshot, before: Stats): Promise<string> {
  charge(snapshot.budget, before.size);
  const descriptor = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const temporary = join(snapshot.seed, "objects", `tmp-${randomBytes(8).toString("hex")}`);
  const hash = createHash(snapshot.format), header = Buffer.from(`blob ${before.size}\0`);
  try {
    if (!sameFile(before, await descriptor.stat())) throw new Error("tracked source changed before private snapshot");
    const content = async function* () {
      hash.update(header); yield header; let offset = 0;
      while (offset < before.size) {
        snapshot.budget.signal?.throwIfAborted();
        const chunk = Buffer.alloc(Math.min(64 * 1024, before.size - offset));
        const read = await descriptor.read(chunk, 0, chunk.length, offset);
        if (read.bytesRead === 0) throw new Error("tracked source changed during private snapshot");
        offset += read.bytesRead; const bytes = chunk.subarray(0, read.bytesRead); hash.update(bytes); yield bytes;
      }
      if (!sameFile(before, await descriptor.stat()) || !sameFile(before, await lstat(path))) throw new Error("tracked source changed during private snapshot");
    };
    const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) { try { charge(snapshot.budget, chunk.length); callback(null, chunk); } catch (reason) { callback(reason as Error); } } });
    await pipeline(content(), createDeflate(), bounded, createWriteStream(temporary, { flags: "wx", mode: 0o600 }), { ...(snapshot.budget.signal === undefined ? {} : { signal: snapshot.budget.signal }) });
    const oid = hash.digest("hex"), directory = join(snapshot.seed, "objects", oid.slice(0, 2));
    await mkdir(directory, { recursive: true }); await rename(temporary, join(directory, oid.slice(2))); return oid;
  } finally { await descriptor.close(); await rm(temporary, { force: true }).catch(() => undefined); }
}

export async function preparePrivateGitSnapshot(input: { source: string; selectedDir?: string; head: string; seed: string; maxBytes?: number; signal?: AbortSignal }): Promise<PrivateGitSnapshot> {
  const emptyConfig = `${input.seed}.empty-config`; await writeFile(emptyConfig, "");
  const deadline = AbortSignal.timeout(120_000), signal = input.signal === undefined ? deadline : AbortSignal.any([input.signal, deadline]);
  const snapshot: PrivateGitSnapshot = { seed: input.seed, commit: input.head, refs: [], shallow: "", format: "sha1", emptyConfig, infoExclude: Buffer.alloc(0), globalExclude: Buffer.alloc(0), trackedPaths: [], untracked: [], ignored: [], unmerged: false, budget: { left: input.maxBytes ?? DEFAULT_GIT_OBJECT_BYTES, signal } };
  if (!Number.isSafeInteger(snapshot.budget.left) || snapshot.budget.left <= 0) throw new Error("invalid Git object import byte limit");
  snapshot.format = (await git(["rev-parse", "--show-object-format"], input.source, snapshot)).trim();
  if (!["sha1", "sha256"].includes(snapshot.format)) throw new Error("unsupported Git object format");
  const refs = await git(["for-each-ref", "--format=%(objectname) %(refname)%09%(symref)"], input.source, snapshot);
  snapshot.refs = refs.split("\n").filter(Boolean).map(line => {
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) (refs\/[^\x00-\x20~^:?*\[\\]+)\t(refs\/[^\x00-\x20~^:?*\[\\]+)?$/.exec(line.replace(/\r$/, ""));
    if (match === null) throw new Error("invalid source Git ref"); return { oid: match[1]!, name: match[2]!, ...(match[3] === undefined ? {} : { symbolic: match[3] }) };
  });
  if (snapshot.refs.length > MAX_OBJECTS) throw new Error("Git object import ref limit exceeded");
  const infoPath = (await git(["rev-parse", "--git-path", "info/exclude"], input.source, snapshot)).trim();
  snapshot.infoExclude = await freezeRule(resolve(input.source, infoPath), snapshot);
  // Read the source's exclusion setting, including its ordinary global config,
  // but copy only rule bytes. No config/include/remote is imported.
  const sourceEnv = env(emptyConfig); delete sourceEnv.GIT_CONFIG_GLOBAL; delete sourceEnv.GIT_CONFIG_NOSYSTEM;
  if (process.env.GIT_CONFIG_GLOBAL !== undefined) sourceEnv.GIT_CONFIG_GLOBAL = process.env.GIT_CONFIG_GLOBAL;
  if (process.env.GIT_CONFIG_NOSYSTEM !== undefined) sourceEnv.GIT_CONFIG_NOSYSTEM = process.env.GIT_CONFIG_NOSYSTEM;
  const global = await runCommand("git", [...prefix, "config", "--path", "--null", "--get", "core.excludesFile"], { cwd: input.source, env: sourceEnv, timeoutMs: 120_000, maxOutputBytes: MAX_OUTPUT, signal });
  if ((global.exitCode !== 0 && global.exitCode !== 1) || global.truncated || global.timedOut) throw new Error("cannot freeze source Git global exclusions");
  const configured = global.stdout.replace(/\0$/, "");
  const globalPath = global.exitCode === 0 ? configured === "" ? null : resolve(input.source, configured) : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "git", "ignore");
  if (globalPath !== null) snapshot.globalExclude = await freezeRule(globalPath, snapshot);
  const shallowPath = (await git(["rev-parse", "--git-path", "shallow"], input.source, snapshot)).trim();
  try {
    const file = resolve(input.source, shallowPath), info = await lstat(file);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error("invalid source shallow boundary");
    snapshot.shallow = await readFile(file, "utf8");
    const length = snapshot.format === "sha256" ? 64 : 40;
    if (snapshot.shallow.trim().split("\n").some(line => !new RegExp(`^[a-f0-9]{${length}}$`).test(line))) throw new Error("invalid source shallow boundary");
    charge(snapshot.budget, Buffer.byteLength(snapshot.shallow));
  } catch (reason) { if ((reason as NodeJS.ErrnoException).code !== "ENOENT") throw reason; }
  await initialize(snapshot.seed, snapshot, true);
  await importObjects(input.source, snapshot.seed, [input.head, ...snapshot.refs.map(ref => ref.oid)], snapshot);
  await installMetadata(snapshot.seed, snapshot, true);
  const indexPath = resolve(input.source, (await git(["rev-parse", "--git-path", "index"], input.source, snapshot)).trim());
  let indexExists = true;
  try { await lstat(indexPath); } catch (reason) { if ((reason as NodeJS.ErrnoException).code !== "ENOENT") throw reason; indexExists = false; }
  if (indexExists) {
    const shared = (await readdir(dirname(indexPath))).filter(name => /^sharedindex\.(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(name));
    if (shared.length > MAX_OBJECTS) throw new Error("Git shared-index inventory limit exceeded");
    for (const file of shared) await copyIndexFile(join(dirname(indexPath), file), join(snapshot.seed, file), snapshot);
    await copyIndexFile(indexPath, join(snapshot.seed, "index"), snapshot);
  } else {
    // A missing source index is an empty index, not permission to create it.
    await git(["read-tree", "--empty"], snapshot.seed, snapshot);
  }
  const privateIndex = ["--git-dir", snapshot.seed, "--work-tree", input.source, "-c", "core.bare=false"];
  const raw = await git([...privateIndex, "ls-files", "--stage", "-z"], input.source, snapshot);
  const entries = raw.split("\0").filter(Boolean);
  if (entries.length > MAX_OBJECTS) throw new Error("Git tracked snapshot entry limit exceeded");
  if (entries.some(line => /^\d{6} [a-f0-9]+ [123]\t/.test(line))) { snapshot.unmerged = true; return finishPreparation(snapshot, input.signal); }
  const selected = relative(input.source, input.selectedDir ?? input.source).replaceAll("\\", "/") || ".";
  const list = async (ignored: boolean): Promise<string[]> => (await git(["--literal-pathspecs", ...privateIndex, "ls-files", "--others", ...(ignored ? ["--ignored", "--directory"] : []), "--exclude-standard", "-z", "--", selected], input.source, snapshot)).split("\0").filter(path => path !== "" && !/^\.git(?:\/|$)/i.test(path));
  snapshot.untracked = await list(false); snapshot.ignored = await list(true);
  // Reconstruct the working-tree snapshot using only this private index.
  const index: string[] = [];
  for (const line of entries) {
    snapshot.budget.signal?.throwIfAborted();
    const match = /^(\d{6}) ([a-f0-9]+) 0\t([\s\S]+)$/.exec(line);
    if (match === null) throw new Error("cannot privately snapshot an unmerged index");
    const path = match[3]!, source = join(input.source, path);
    snapshot.trackedPaths.push(path);
    let info; try { info = await lstat(source); } catch (reason) { if ((reason as NodeJS.ErrnoException).code === "ENOENT") continue; throw reason; }
    if (info.isSymbolicLink()) {
      const link = await readlink(source); charge(snapshot.budget, Buffer.byteLength(link));
      const oid = (await git(["hash-object", "-w", "--stdin"], snapshot.seed, snapshot, link)).trim(); index.push(`120000 ${oid}\t${path}\0`);
    } else if (info.isFile()) {
      const oid = await writeBlob(source, snapshot, info);
      const mode = process.platform === "win32" ? match[1] === "100755" ? "100755" : "100644" : (info.mode & 0o111) === 0 ? "100644" : "100755";
      index.push(`${mode} ${oid}\t${path}\0`);
    } else if (info.isDirectory() && match[1] === "160000") index.push(`160000 ${match[2]}\t${path}\0`);
  }
  await git(["read-tree", "--empty"], snapshot.seed, snapshot);
  await git(["update-index", "-z", "--index-info"], snapshot.seed, snapshot, index.join(""));
  const tree = (await git(["write-tree"], snapshot.seed, snapshot)).trim();
  const baseTree = (await git(["rev-parse", `${input.head}^{tree}`], snapshot.seed, snapshot)).trim();
  if (tree !== baseTree) snapshot.commit = (await git(["commit-tree", tree, "-p", input.head], snapshot.seed, snapshot, "Fusion working-tree snapshot\n")).trim();
  await writeFile(join(snapshot.seed, "HEAD"), `${snapshot.commit}\n`);
  return finishPreparation(snapshot, input.signal);
}

export async function materializePrivateGitWorkspace(root: string, snapshot: PrivateGitSnapshot): Promise<void> {
  const deadline = AbortSignal.timeout(120_000), signal = snapshot.budget.signal === undefined ? deadline : AbortSignal.any([snapshot.budget.signal, deadline]);
  const operation = { ...snapshot, budget: { left: snapshot.budget.left, signal } };
  try {
    await initialize(root, operation, false);
    await importObjects(operation.seed, root, [operation.commit, ...operation.refs.map(ref => ref.oid)], operation);
    await installMetadata(root, operation, false);
    await git(["read-tree", "--reset", "-u", "HEAD"], root, operation);
  } finally { snapshot.budget.left = operation.budget.left; }
}
