/**
 * Runs one fit-test task through the real agent (ATO-1090): a child
 * `atomic-agent run` in a fresh temp working dir AND a fresh temp state
 * dir, pointed at the model the parent loaded.
 *
 * Dry by construction:
 * - the prompt goes in and stdin closes, so every approval prompt is
 *   answered by EOF, which denies it (`src/cli/README.md`, `run`): mail,
 *   pushes, posts, shell commands and writing HTTP calls that ask are
 *   refused;
 * - the temp state dir means the run's chat, memory notes, scheduled
 *   tasks and skills never reach the user's own state, and both temp
 *   dirs are removed afterwards;
 * - the task set already left out tasks that sent things outside
 *   (`outbound-calls.ts`);
 * - the child's environment drops every credential-looking variable
 *   (`buildCommandEnv`, as for the agent's shell commands): only the
 *   loaded model's key is passed on.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_CONFIG_VERSION } from "../config/config-schema.js";
import { isSeaBuild, selfInvocation } from "../runtime/self-invocation.js";
import { buildCommandEnv } from "../sandbox/command-env.js";
import { killProcessTree } from "../sandbox/kill-process-tree.js";
import type { FitTask } from "./fit-task.js";
import type { AgentTaskOutcome } from "./fit-test-types.js";

export interface AgentTaskRunnerOptions {
  /** Chat completion server of the loaded model. */
  modelUrl: string;
  modelApiKey: string | null;
  timeoutMs: number;
  defaultMaxSteps?: number;
  /**
   * Aborted when the fit-test is stopped (SIGINT / SIGTERM, ATO-1498): a
   * task not started yet is skipped, a running child gets SIGTERM and,
   * if still alive after a short grace, SIGKILL. The temp dirs go once it
   * has exited.
   */
  signal?: AbortSignal;
  /** Test seam for the platform the child is stopped on (`killProcessTree`). */
  platform?: NodeJS.Platform;
}

/** How long a stopped child gets to exit on SIGTERM before SIGKILL. */
const STOP_KILL_GRACE_MS = 3000;

/** The child's config: external mode on the loaded model, traces on for token counts. */
export function childConfig(modelUrl: string): Record<string, unknown> {
  return {
    version: USER_CONFIG_VERSION,
    localModels: { mode: "external", url: modelUrl },
    tracing: { trace: { enabled: true } },
  };
}

/** Prompt plus generated tokens from the run's trace files, or `null` when none were found. */
export function countTraceTokens(traceText: string): number | null {
  let total = 0;
  let seen = false;
  for (const line of traceText.split("\n")) {
    if (line.trim() === "") continue;
    let event: { type?: unknown; tokens?: { total?: unknown }; timing?: { predictedTokens?: unknown } };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type === "prompt_captured" && typeof event.tokens?.total === "number") {
      total += event.tokens.total;
      seen = true;
    } else if (event.type === "llm_completion" && typeof event.timing?.predictedTokens === "number") {
      total += event.timing.predictedTokens;
      seen = true;
    }
  }
  return seen ? total : null;
}

function readTraces(stateDir: string): string {
  const dir = join(stateDir, "traces");
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".ndjson"))
      .map((name) => readFileSync(join(dir, name), "utf8"))
      .join("\n");
  } catch {
    return "";
  }
}

export function createAgentTaskRunner(options: AgentTaskRunnerOptions): (task: FitTask) => Promise<AgentTaskOutcome> {
  return async (task) => {
    if (options.signal?.aborted) {
      return { reply: "", durationMs: 0, tokens: null, timedOut: false, error: "stopped" };
    }
    const root = mkdtempSync(join(tmpdir(), "atomic-fit-"));
    const workDir = join(root, "work");
    const stateDir = join(root, "state");
    try {
      for (const dir of [workDir, stateDir]) mkdirSync(dir);
      writeFileSync(join(stateDir, "config.json"), JSON.stringify(childConfig(options.modelUrl)), { mode: 0o600 });
      const self = selfInvocation({ execPath: process.execPath, argv: process.argv, execArgv: process.execArgv, isSea: isSeaBuild() });
      const maxSteps = task.maxSteps ?? options.defaultMaxSteps ?? 15;
      const args = [...self.args, "run", "--cwd", workDir, "--max-steps", String(maxSteps)];
      // The replay must not carry the user's credentials (GitHub, Composio,
      // providers, mail): the child only talks to the loaded model, whose
      // key is the one passed back in below.
      const env: NodeJS.ProcessEnv = { ...buildCommandEnv(process.env), ATOMIC_AGENT_STATE_DIR: stateDir, FORCE_COLOR: "0", NO_COLOR: "1" };
      if (options.modelApiKey) env.ATOMIC_AGENT_LLAMA_API_KEY = options.modelApiKey;
      else delete env.ATOMIC_AGENT_LLAMA_API_KEY;
      const started = Date.now();
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; stopped: boolean }>((resolve, reject) => {
        const child = spawn(self.cmd, args, { env, stdio: ["pipe", "pipe", "pipe"], ...(process.platform === "win32" ? { windowsHide: true } : {}) });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let stopped = false;
        let killTimer: ReturnType<typeof setTimeout> | null = null;
        // The child's whole tree: on Windows `child.kill` is TerminateProcess
        // on one pid, and the agent's own children would keep running.
        const killTree = (force: boolean): void =>
          killProcessTree(child, { force, ...(options.platform ? { platform: options.platform } : {}) });
        const timer = setTimeout(() => {
          timedOut = true;
          killTree(true);
        }, options.timeoutMs);
        const onAbort = (): void => {
          stopped = true;
          killTree(false);
          killTimer = setTimeout(() => killTree(true), STOP_KILL_GRACE_MS);
        };
        const settle = (): void => {
          clearTimeout(timer);
          if (killTimer !== null) clearTimeout(killTimer);
          options.signal?.removeEventListener("abort", onAbort);
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
        child.on("error", (err) => {
          settle();
          reject(err);
        });
        child.on("close", (code) => {
          settle();
          resolve({ code, stdout, stderr, timedOut, stopped });
        });
        // `run` takes one piped line per turn: a multi-line prompt goes in as one line.
        child.stdin.end(`${task.prompt.replace(/\r?\n/g, " ")}\n`);
      });
      const reply = result.stdout.trim();
      const tail = result.stderr.trim().split("\n").slice(-1)[0] ?? "";
      return {
        reply,
        durationMs: Date.now() - started,
        tokens: countTraceTokens(readTraces(stateDir)),
        timedOut: result.timedOut,
        error: result.stopped ? "stopped" : result.timedOut ? "timed out" : result.code === 0 ? null : `agent exited ${String(result.code)}: ${tail.slice(0, 200)}`,
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}
