import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { buildCommandEnv } from "../../sandbox/command-env.js";
import { runCommand, type CommandResult } from "../../sandbox/command-runner.js";
import { VERIFY_COPY_EXCLUDED } from "../verify/verify-workspace-copy.js";

export type IgnoreGit = (
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal },
) => Promise<CommandResult | null>;

export type DirectoryIgnorePolicy = (paths: readonly string[], signal?: AbortSignal) => Promise<ReadonlySet<string>>;

const defaultIgnoreGit: IgnoreGit = async (args, options) => {
  options.signal?.throwIfAborted();
  try {
    return await runCommand("git", ["--no-pager", "-c", "core.hooksPath=/dev/null", ...args], {
      ...options,
      env: {
        ...Object.fromEntries(Object.entries(buildCommandEnv(process.env)).filter(([name]) => options.env === undefined || !/^GIT_/i.test(name))),
        GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...options.env,
      },
      timeoutMs: 120_000,
      maxOutputBytes: 32 * 1024 * 1024,
    });
  } catch { return null; }
};

function completed(result: CommandResult | null): result is CommandResult {
  return result !== null && !result.timedOut && !result.truncated && !result.inputTruncated;
}

function outputPath(output: string): string {
  return output.endsWith("\n") ? output.slice(0, -1) : output;
}

async function repositoryAncestor(dir: string): Promise<string | null> {
  for (let current = dir; ; current = dirname(current)) {
    try {
      const marker = await lstat(join(current, ".git"));
      if (marker.isDirectory() || marker.isFile() || marker.isSymbolicLink()) return current;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (dirname(current) === current) return null;
  }
}

/**
 * Freeze Git's ignore inputs in a private repository, never its original
 * metadata. Queries use the frozen tree even after a task changes its own
 * .gitignore or the original's global/info excludes. Only directories are
 * classified: standalone ignored files retain their delivery semantics.
 */
export async function createDirectoryIgnorePolicy(input: {
  originalDir: string;
  baseDir: string;
  probeDir: string;
  /** Charges each frozen rule file to the same cumulative copy budget. */
  copy: (from: string, to: string) => Promise<void>;
  git?: IgnoreGit;
  signal?: AbortSignal;
}): Promise<DirectoryIgnorePolicy | undefined> {
  const rawGit = input.git ?? defaultIgnoreGit;
  const git: IgnoreGit = (args, options) => { input.signal?.throwIfAborted(); return rawGit(args, { ...options, ...(input.signal === undefined ? {} : { signal: input.signal }) }); };
  const gitDir = join(input.probeDir, "metadata.git");
  const tree = join(input.probeDir, "tree");
  await mkdir(tree, { recursive: true });
  const emptyConfig = join(input.probeDir, "empty-config");
  await writeFile(emptyConfig, "");
  const isolated: NodeJS.ProcessEnv = {
    GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: "",
    GIT_DIR: gitDir, GIT_INDEX_FILE: join(input.probeDir, "index"),
  };
  let hasRules = false;
  const freeze = async (from: string, to: string, followLink = false): Promise<void> => {
    input.signal?.throwIfAborted();
    let info;
    try { info = await lstat(from); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    // Git deliberately does not follow .gitignore symlinks. Configured
    // info/global exclude files may be links; freeze their actual bytes.
    if (info.isSymbolicLink() && !followLink) return;
    if (!info.isFile() && !(followLink && info.isSymbolicLink())) throw new Error(`cannot freeze Git ignore rules: ${from}`);
    await input.copy(await realpath(from), to);
    input.signal?.throwIfAborted();
    hasRules = true;
  };
  const topResult = await git(["rev-parse", "--show-toplevel"], { cwd: input.originalDir });
  const top = completed(topResult) && topResult.exitCode === 0
    ? outputPath(topResult.stdout)
    : !completed(topResult) ? await repositoryAncestor(input.originalDir) : null;
  const subdir = top === null ? "" : relative(top, input.originalDir);
  if (subdir === ".." || subdir.startsWith(`..${sep}`) || isAbsolute(subdir)) throw new Error("cannot freeze Git ignore rules outside the repository");
  const cwd = join(tree, subdir);
  await mkdir(cwd, { recursive: true });
  if (top !== null) {
    let ancestor = dirname(input.originalDir);
    while (ancestor === top || (relative(top, ancestor) !== ".." && !relative(top, ancestor).startsWith(`..${sep}`) && !isAbsolute(relative(top, ancestor)))) {
      input.signal?.throwIfAborted();
      if (input.originalDir === top) break;
      await freeze(join(ancestor, ".gitignore"), join(tree, relative(top, ancestor), ".gitignore"));
      if (ancestor === top) break;
      ancestor = dirname(ancestor);
    }
  }
  const visit = async (source: string, dest: string): Promise<void> => {
    input.signal?.throwIfAborted();
    for (const entry of await readdir(source, { withFileTypes: true })) {
      input.signal?.throwIfAborted();
      if (VERIFY_COPY_EXCLUDED.has(entry.name)) continue;
      if (entry.name === ".gitignore") await freeze(join(source, entry.name), join(dest, entry.name));
      else if (entry.isDirectory()) await visit(join(source, entry.name), join(dest, entry.name));
    }
  };
  await visit(input.baseDir, cwd);
  const initialized = await git(["init", "--bare", "-q", gitDir], { cwd: input.probeDir, env: isolated });
  if (!completed(initialized) || initialized.exitCode !== 0) {
    if (hasRules || top !== null) throw new Error("Git is unavailable; cannot classify workspace ignore directories safely");
    return undefined;
  }
  const infoFile = join(gitDir, "info", "exclude");
  await mkdir(dirname(infoFile), { recursive: true });
  await writeFile(infoFile, "");
  if (top !== null) {
    const info = await git(["rev-parse", "--git-path", "info/exclude"], { cwd: input.originalDir });
    if (!completed(info) || info.exitCode !== 0) throw new Error("Git could not locate the workspace's info exclude rules");
    await freeze(resolve(input.originalDir, outputPath(info.stdout)), infoFile, true);
  }
  const globalFile = join(input.probeDir, "global-excludes");
  await writeFile(globalFile, "");
  const global = await git(["config", "--path", "--null", "--get", "core.excludesFile"], { cwd: input.originalDir });
  if (!completed(global) || (global.exitCode !== 0 && global.exitCode !== 1)) throw new Error("Git could not locate the workspace's global ignore rules");
  const configuredGlobal = global.stdout.replace(/\0$/, "");
  const globalSource = global.exitCode === 0
    ? configuredGlobal.length === 0 ? null : resolve(input.originalDir, configuredGlobal)
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "git", "ignore");
  if (globalSource !== null) await freeze(globalSource, globalFile, true);
  return async (paths, signal) => {
    signal?.throwIfAborted();
    if (paths.length === 0) return new Set();
    const listed = await rawGit(["-c", "core.bare=false", "-c", `core.excludesFile=${globalFile}`, "check-ignore", "--no-index", "-z", "--stdin"], {
      cwd,
      env: { ...isolated, GIT_WORK_TREE: tree },
      input: paths.map((path) => `${path.split(sep).join("/")}/\0`).join(""),
      ...(signal === undefined ? {} : { signal }),
    });
    signal?.throwIfAborted();
    if (!completed(listed) || (listed.exitCode !== 0 && listed.exitCode !== 1)) {
      throw new Error("Git could not classify the private workspace's ignored directories");
    }
    return new Set(listed.stdout.split("\0").filter(Boolean).map((path) => path.replace(/\/$/, "").split("/").join(sep)));
  };
}
