/**
 * TypeScript: `tsc --noEmit` against the project's own `tsconfig.json`,
 * once per project, with the diagnostics attributed back to the files
 * that were asked about.
 *
 * Per-file `tsc a.ts` would ignore the tsconfig (paths, jsx, lib) and
 * fail on any import, so the project is the unit of checking. A file the
 * project does not include gets no verdict rather than a pass: tsc said
 * nothing about it.
 *
 * "No checker" when there is no tsconfig above the file or no `tsc`
 * under a `node_modules/.bin` above the project — a global `tsc` is
 * not consulted, since its version is not the project's.
 *
 * `parseOnly` (the fusion delegate's own pass) fails a file only on its
 * parse diagnostics (`isParseDiagnostic`): a type error, a missing
 * module or missing `@types` is reported on the result as `typeErrors`
 * and leaves it `ok`. `verify.syntax` itself keeps every diagnostic a
 * failure.
 *
 * Writes nothing into the project: `--noEmit`, and the build info an
 * incremental project would drop beside its tsconfig is redirected to
 * the OS temp dir and removed.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { runChecker } from "./check-script-syntax.js";
import { type SyntaxFileResult, tailOfOutput } from "./syntax-check-types.js";

export const TS_CHECKER = "tsc --noEmit";
const TSC_TIMEOUT_MS = 300_000;

/** The nearest `tsconfig.json` at or above `dir`, or `null`. */
export function findTsconfig(dir: string): string | null {
  let current = resolve(dir);
  for (;;) {
    const candidate = join(current, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The nearest `node_modules/.bin/tsc` at or above `dir`, or `null`. */
export function findTscBinary(dir: string): string | null {
  const name = process.platform === "win32" ? "tsc.cmd" : "tsc";
  let current = resolve(dir);
  for (;;) {
    const candidate = join(current, "node_modules", ".bin", name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** One `file(line,col): error TSnnnn: …` line, as the result shows it. */
interface Diagnostic {
  readonly code: number;
  readonly text: string;
}

/**
 * TS1xxx codes that are not about the file's syntax: they depend on the
 * project's module settings or on another module (no default export,
 * `esModuleInterop`, `isolatedModules`, type-only imports, CommonJS
 * importing ESM), so a correct file can carry them.
 */
const NON_PARSE_TS1_CODES: ReadonlySet<number> = new Set([
  1192, 1205, 1208, 1259, 1371, 1479, 1484, 1485,
]);

/**
 * Whether a tsc diagnostic is about the file's syntax: the TS1xxx
 * range (scanner, parser and grammar errors), less the module- and
 * config-dependent codes above. TS2xxx and up are type checking.
 */
export function isParseDiagnostic(code: number): boolean {
  return code >= 1000 && code < 2000 && !NON_PARSE_TS1_CODES.has(code);
}

interface ProjectCheck {
  readonly ok: boolean;
  /** Absolute path → diagnostics naming it. */
  readonly diagnostics: ReadonlyMap<string, readonly Diagnostic[]>;
  /** Absolute paths the project compiled (from `--listFiles`). */
  readonly included: ReadonlySet<string>;
  readonly errorCount: number;
  /** tsc itself failed (crash, timeout) — no verdict for anyone. */
  readonly failure: string | null;
}

const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): (error TS(\d+): .*)$/;

async function checkProject(
  tsconfig: string,
  tsc: string,
  signal: AbortSignal | undefined,
): Promise<ProjectCheck> {
  const projectDir = dirname(tsconfig);
  // An `incremental` (or `composite`) project writes `tsconfig.tsbuildinfo`
  // next to itself even under `--noEmit`. Point it at the temp dir
  // instead: `--incremental` is legal with `--noEmit`, and forcing it on
  // costs a non-incremental project nothing but a throwaway file.
  const buildInfo = join(tmpdir(), `atag-verify-${randomBytes(4).toString("hex")}.tsbuildinfo`);
  const run = await runChecker(
    tsc,
    ["--noEmit", "-p", tsconfig, "--pretty", "false", "--listFiles", "--incremental", "--tsBuildInfoFile", buildInfo],
    { cwd: projectDir, timeoutMs: TSC_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
  );
  await rm(buildInfo, { force: true });
  if (run.missing) {
    return { ok: false, diagnostics: new Map(), included: new Set(), errorCount: 0, failure: "tsc could not be started" };
  }
  if (run.timedOut) {
    const failure = run.aborted === true ? "not checked: cancelled" : "tsc timed out";
    return { ok: false, diagnostics: new Map(), included: new Set(), errorCount: 0, failure };
  }
  const diagnostics = new Map<string, Diagnostic[]>();
  const included = new Set<string>();
  let errorCount = 0;
  for (const raw of run.stdout.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const match = line.match(DIAGNOSTIC);
    if (match) {
      const path = resolve(projectDir, match[1]!);
      errorCount += 1;
      const list = diagnostics.get(path) ?? [];
      list.push({ code: Number(match[5]), text: `line ${match[2]}: ${match[4]}` });
      diagnostics.set(path, list);
      continue;
    }
    if (isAbsolute(line) && !line.includes(": ")) included.add(resolve(line));
  }
  if (run.exitCode !== 0 && errorCount === 0) {
    // Exit 1 with no `file(line,col)` diagnostics: a config error or a
    // crash, and tsc printed why to stdout or stderr.
    return {
      ok: false,
      diagnostics,
      included,
      errorCount,
      failure: tailOfOutput(`${run.stdout}\n${run.stderr}`, 4) || `tsc exited ${run.exitCode}`,
    };
  }
  return { ok: run.exitCode === 0, diagnostics, included, errorCount, failure: null };
}

function withoutVerdict(file: string, error: string): SyntaxFileResult {
  return { file, ok: null, checker: "none", error };
}

export interface TypeScriptCheckOptions {
  /** Fail a file only on its parse diagnostics (`isParseDiagnostic`). */
  readonly parseOnly?: boolean;
  /** Kills `tsc` when it aborts; the files get no verdict. */
  readonly signal?: AbortSignal;
}

/**
 * Check `.ts` / `.tsx` files (given as `{file, absolute}` pairs). Files
 * that share a tsconfig share one `tsc` run.
 */
export async function checkTypeScriptFiles(
  files: readonly { file: string; absolute: string }[],
  options: TypeScriptCheckOptions = {},
): Promise<SyntaxFileResult[]> {
  const byProject = new Map<string, { file: string; absolute: string }[]>();
  const results = new Map<string, SyntaxFileResult>();
  for (const entry of files) {
    const tsconfig = findTsconfig(dirname(entry.absolute));
    if (tsconfig === null) {
      results.set(entry.absolute, withoutVerdict(entry.file, "no tsconfig.json above the file"));
      continue;
    }
    const group = byProject.get(tsconfig) ?? [];
    group.push(entry);
    byProject.set(tsconfig, group);
  }
  for (const [tsconfig, group] of byProject) {
    const projectDir = dirname(tsconfig);
    const tsc = findTscBinary(projectDir);
    if (tsc === null) {
      for (const entry of group) {
        results.set(entry.absolute, withoutVerdict(entry.file, `no node_modules/.bin/tsc above ${projectDir}`));
      }
      continue;
    }
    const project = await checkProject(tsconfig, tsc, options.signal);
    for (const entry of group) {
      results.set(entry.absolute, attribute(entry, project, tsconfig, options.parseOnly === true));
    }
  }
  return files.map((entry) => results.get(entry.absolute)!);
}

function attribute(
  entry: { file: string; absolute: string },
  project: ProjectCheck,
  tsconfig: string,
  parseOnly: boolean,
): SyntaxFileResult {
  const { file, absolute } = entry;
  if (project.failure !== null) {
    return { file, ok: null, checker: TS_CHECKER, error: project.failure };
  }
  const own = project.diagnostics.get(absolute) ?? [];
  const failing = parseOnly ? own.filter((d) => isParseDiagnostic(d.code)) : own;
  if (failing.length > 0) {
    return { file, ok: false, checker: TS_CHECKER, error: listDiagnostics(failing) };
  }
  if (own.length === 0 && !project.included.has(absolute)) {
    return withoutVerdict(file, `not included by ${tsconfig}`);
  }
  const typeErrors =
    own.length === 0 ? {} : { typeErrors: { count: own.length, detail: listDiagnostics(own) } };
  const elsewhere = project.errorCount - own.length;
  if (elsewhere > 0) {
    return {
      file,
      ok: true,
      checker: TS_CHECKER,
      ...typeErrors,
      warning: `tsc reported ${elsewhere} error(s) in other files of ${dirname(tsconfig)}`,
    };
  }
  return { file, ok: true, checker: TS_CHECKER, ...typeErrors };
}

/** The first three diagnostics, `; `-joined, then `(+N more)`. */
function listDiagnostics(list: readonly Diagnostic[]): string {
  const shown = list.slice(0, 3).map((d) => d.text).join("; ");
  return list.length > 3 ? `${shown} (+${list.length - 3} more)` : shown;
}
