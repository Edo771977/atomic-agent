/**
 * `models fit-test --tasks <file> --models <a,b[,c]> --judge-url <url>`
 * (ATO-1090): run the user's own task set (`models tasks collect`) on up
 * to three local models, one at a time, score every reply with a judge,
 * and print a table of score, time and peak memory per model.
 *
 * Each model is made active and started through the same handlers as
 * `models use` / `models start`, then stopped. When the run ends the
 * model that was active before is put back, and started again if it
 * was running. Every task runs in a temp working dir and a temp state
 * dir with approvals refused (`fit-test/agent-task-runner.ts`).
 *
 * Stopped by SIGINT (Ctrl+C) or SIGTERM (the desktop's Cancel), the run
 * winds down instead of dying (ATO-1498): the running child is stopped,
 * its temp dirs removed, the previous model put back, and the command
 * exits 130 / 143. A second signal quits at once.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig, resetConfigCache } from "../config/index.js";
import {
  createAgentTaskRunner,
  createFitJudge,
  formatFitTable,
  parseFitTaskSet,
  readProcessRssBytes,
  runFitTest,
  type FitTestDeps,
  type LoadedFitModel,
} from "../fit-test/index.js";
import { getDaemonStatus, getEmbeddingDaemonStatus, stopEmbeddingDaemon } from "../local-llm/index.js";
import { readRecommendSnapshot } from "../local-llm/model-upgrade-runner.js";
import {
  readCliOption,
  runLocalModelsStart,
  runLocalModelsStartEmbedding,
  runLocalModelsStop,
  runLocalModelsUse,
} from "./models-handlers.js";

const MAX_MODELS = 3;
const DEFAULT_TIMEOUT_S = 300;

export const FIT_TEST_USAGE =
  "usage: atomic-agent models fit-test --tasks <file> --models <id,id[,id]> --judge-url <url>\n" +
  "         [--judge-model <id>] [--judge-key-env <ENV_NAME>] [--timeout <seconds>] [--out <file>] [--json]\n";

export interface FitTestArgs {
  tasksPath: string;
  modelIds: string[];
  judgeUrl: string;
  judgeModel: string;
  judgeKeyEnv: string | null;
  timeoutMs: number;
  outPath: string | null;
  json: boolean;
}

export function parseFitTestArgs(args: string[]): FitTestArgs | { error: string } {
  const tasksPath = readCliOption(args, "--tasks");
  if (!tasksPath) return { error: "--tasks <file> is required (write one with `models tasks collect`)" };
  const modelIds = [...new Set((readCliOption(args, "--models") ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  if (modelIds.length === 0) return { error: "--models needs one to three model ids, comma separated" };
  if (modelIds.length > MAX_MODELS) return { error: `--models takes at most ${MAX_MODELS} models` };
  const judgeUrl = readCliOption(args, "--judge-url");
  if (!judgeUrl) return { error: "--judge-url is required: the judge reads your prompts, so choose where they go" };
  const timeoutRaw = readCliOption(args, "--timeout");
  const timeoutS = timeoutRaw === undefined ? DEFAULT_TIMEOUT_S : Number(timeoutRaw);
  if (!Number.isInteger(timeoutS) || timeoutS <= 0) return { error: "--timeout needs a whole number of seconds" };
  return {
    tasksPath: resolve(tasksPath),
    modelIds,
    judgeUrl,
    judgeModel: readCliOption(args, "--judge-model") ?? "judge",
    judgeKeyEnv: readCliOption(args, "--judge-key-env") ?? null,
    timeoutMs: timeoutS * 1000,
    outPath: readCliOption(args, "--out") ? resolve(readCliOption(args, "--out") as string) : null,
    json: args.includes("--json"),
  };
}

async function chatDaemonStatus() {
  const cfg = getConfig();
  return getDaemonStatus(cfg.paths.localModelsDataDir, cfg.localModels.managed.port);
}

/** What the run found before it touched anything, to put back afterwards. */
export interface FitModelSnapshot {
  /** The active managed model. */
  previous: string | null;
  chatRunning: boolean;
  embeddingRunning: boolean;
}

async function embeddingDaemonStatus() {
  const cfg = getConfig();
  return getEmbeddingDaemonStatus(cfg.paths.localModelsDataDir, cfg.localModels.embeddings.port);
}

export async function readFitModelSnapshot(): Promise<FitModelSnapshot> {
  return {
    previous: getConfig().localModels.managed.modelId,
    chatRunning: (await chatDaemonStatus()).running,
    embeddingRunning: (await embeddingDaemonStatus().catch(() => ({ running: false }))).running,
  };
}

/**
 * Loads the test models in turn and puts the user's models back.
 *
 * Only the chat model is swapped (`models stop --chat-only`): the
 * embedding model keeps serving memory search through the run, and at
 * the end it is left as it was found, up or down.
 *
 * Prompt disk cache (ATO-456): the first stop is the user's own model, so
 * its conversations are saved once, as any stop saves them. Test models
 * start with the cache suspended (`promptCache: "suspend"`): no save
 * path, and none of the restore-time cleanup that deletes saves from
 * another launch, so the user's saves are still there when their model
 * starts again. Their stops save nothing (`savePromptCache: false`).
 */
export function createFitModelSwitcher(snapshot: FitModelSnapshot) {
  // A holder: the first stop saves the user's caches, no later one does.
  const state = { userCachesSaved: false };
  const stopChat = async (): Promise<void> => {
    const savePromptCache = !state.userCachesSaved;
    state.userCachesSaved = true;
    await runLocalModelsStop(savePromptCache ? { chatOnly: true } : { chatOnly: true, savePromptCache: false });
  };
  return {
    /** Makes `modelId` the active managed model and starts it. */
    async load(modelId: string, signal: AbortSignal): Promise<LoadedFitModel> {
      if (signal.aborted) throw new Error("stopped");
      await stopChat();
      if ((await runLocalModelsUse(modelId)) !== 0) throw new Error("unknown model id");
      if ((await runLocalModelsStart({ signal, promptCache: "suspend" })) !== 0) {
        throw new Error("the model did not start (is it downloaded?)");
      }
      resetConfigCache();
      const cfg = getConfig();
      const status = await chatDaemonStatus();
      return {
        url: cfg.localModels.url,
        apiKey: cfg.localModels.apiKey,
        pid: status.pid,
        release: stopChat,
      };
    },
    /**
     * Puts back the model that was active before the run, started again
     * if it was running, and the embedding model as it was. After a stop
     * the test model may still be loaded (its release did not run), so
     * it is stopped first.
     */
    async restore(stopped: boolean): Promise<void> {
      if (stopped) await stopChat();
      if (snapshot.previous !== null) {
        await runLocalModelsUse(snapshot.previous);
        if (snapshot.chatRunning) await runLocalModelsStart({});
      }
      const embeddingNow = (await embeddingDaemonStatus().catch(() => ({ running: snapshot.embeddingRunning }))).running;
      if (snapshot.embeddingRunning && !embeddingNow) {
        await runLocalModelsStartEmbedding();
      } else if (!snapshot.embeddingRunning && embeddingNow) {
        // A test model's start brought it up. With no chat model to keep,
        // the full stop also lets an idle Atomic Core exit.
        if (snapshot.chatRunning) await stopEmbeddingDaemon(getConfig().paths.localModelsDataDir);
        else await runLocalModelsStop({ savePromptCache: false });
      }
    },
  };
}

const STOP_EXIT_CODE = { SIGINT: 130, SIGTERM: 143 } as const;
export type FitStopSignal = keyof typeof STOP_EXIT_CODE;

/** How long a stopped run gets to wind down before the model is put back anyway. */
const STOP_GRACE_MS = 15_000;

export interface FitStopSignalTarget {
  on(signal: FitStopSignal, listener: () => void): unknown;
  off(signal: FitStopSignal, listener: () => void): unknown;
}

export interface FitStopDeps {
  target?: FitStopSignalTarget;
  exit?: (code: number) => void;
  write?: (text: string) => void;
  /** Wait for the run to wind down before restoring regardless (ms). */
  graceMs?: number;
}

export type FitStopOutcome<T> = { stoppedBy: null; result: T } | { stoppedBy: FitStopSignal; exitCode: number };

/** Runs `fn` once; later calls get the first call's promise. */
export function callOnce<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  let pending: Promise<void> | null = null;
  return (...args: A) => (pending ??= fn(...args));
}

/**
 * Runs `run` and always calls `restore` afterwards, also when SIGINT or
 * SIGTERM arrives (ATO-1498): a plain `finally` does not run when the
 * process is killed by a signal. The first signal aborts the signal
 * passed to `run`; once `run` settles, `restore(true)` runs and the
 * outcome carries the conventional exit code (130 / 143). If `run` has
 * not settled after `graceMs`, the model is restored anyway and the
 * process exits. A second signal exits at once. `restore` runs at most
 * once, and the listeners are removed before this returns.
 */
export async function runRestoringOnStop<T>(
  run: (signal: AbortSignal) => Promise<T>,
  restore: (stopped: boolean) => Promise<void>,
  deps: FitStopDeps = {},
): Promise<FitStopOutcome<T>> {
  const target: FitStopSignalTarget = deps.target ?? process;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const write = deps.write ?? ((text: string) => void process.stderr.write(text));
  const graceMs = deps.graceMs ?? STOP_GRACE_MS;
  const controller = new AbortController();
  const restoreOnce = callOnce(restore);
  // A holder, not `let`s: they change inside the listeners.
  const state: { stoppedBy: FitStopSignal | null; graceTimer: ReturnType<typeof setTimeout> | null } = {
    stoppedBy: null,
    graceTimer: null,
  };
  const listeners = new Map<FitStopSignal, () => void>();
  for (const signal of Object.keys(STOP_EXIT_CODE) as FitStopSignal[]) {
    const listener = (): void => {
      if (state.stoppedBy !== null) {
        exit(STOP_EXIT_CODE[signal]);
        return;
      }
      state.stoppedBy = signal;
      write(`\n${signal}: stopping the fit-test and putting the previous model back (send it again to quit at once)\n`);
      controller.abort();
      state.graceTimer = setTimeout(() => {
        write("the run did not stop in time; putting the previous model back now\n");
        void restoreOnce(true)
          .catch((err: unknown) => write(`restoring the previous model failed: ${err instanceof Error ? err.message : String(err)}\n`))
          .finally(() => exit(STOP_EXIT_CODE[signal]));
      }, graceMs);
    };
    listeners.set(signal, listener);
    target.on(signal, listener);
  }
  try {
    let result: T | undefined;
    let failure: { error: unknown } | null = null;
    try {
      result = await run(controller.signal);
    } catch (error) {
      failure = { error };
    }
    if (state.graceTimer !== null) clearTimeout(state.graceTimer);
    const stopped = state.stoppedBy;
    if (stopped === null) {
      await restoreOnce(false);
      if (failure !== null) throw failure.error;
      return { stoppedBy: null, result: result as T };
    }
    try {
      await restoreOnce(true);
    } catch (err) {
      write(`restoring the previous model failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    return { stoppedBy: stopped, exitCode: STOP_EXIT_CODE[stopped] };
  } finally {
    // A signal during the normal path's restore arms a grace timer too; it must not exit later.
    if (state.graceTimer !== null) clearTimeout(state.graceTimer);
    for (const [signal, listener] of listeners) target.off(signal, listener);
  }
}

export async function runModelsFitTest(args: string[]): Promise<number> {
  const parsed = parseFitTestArgs(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n${FIT_TEST_USAGE}`);
    return 2;
  }
  const cfg = getConfig();
  if (cfg.localModels.mode !== "managed") {
    process.stderr.write("fit-test loads models itself, so it needs managed mode (`atomic-agent models use <id>`)\n");
    return 1;
  }
  const set = parseFitTaskSet(JSON.parse(readFileSync(parsed.tasksPath, "utf8")));
  if (set.tasks.length === 0) {
    process.stderr.write("the task set is empty\n");
    return 1;
  }
  const judgeKey = parsed.judgeKeyEnv ? (process.env[parsed.judgeKeyEnv] ?? null) : null;
  const judge = createFitJudge({ url: parsed.judgeUrl, model: parsed.judgeModel, apiKey: judgeKey });
  const snapshot = await readFitModelSnapshot();
  const switcher = createFitModelSwitcher(snapshot);
  const depsFor = (signal: AbortSignal): FitTestDeps => ({
    loadModel: (modelId) => switcher.load(modelId, signal),
    runTask: (task, model) =>
      createAgentTaskRunner({ modelUrl: model.url, modelApiKey: model.apiKey, timeoutMs: parsed.timeoutMs, signal })(task),
    // After a stop no reply goes to the judge.
    judge: async (task, reply) => {
      if (signal.aborted) throw new Error("stopped");
      return judge(task.prompt, reply, task.expectations[0]?.rubric ?? "");
    },
    sampleMemory: readProcessRssBytes,
    progress: (line) => process.stderr.write(`${line}\n`),
  });
  const gpuBudgetGb = await readRecommendSnapshot()
    .then((snap) => snap.machine.gpuBudgetGb)
    .catch(() => null);
  const outcome = await runRestoringOnStop(
    (signal) => runFitTest(set, parsed.modelIds, depsFor(signal), { gpuBudgetGb }),
    (stopped) => switcher.restore(stopped),
  );
  if (outcome.stoppedBy !== null) return outcome.exitCode;
  const run = outcome.result;
  const body = `${JSON.stringify(run, null, 2)}\n`;
  if (parsed.outPath !== null) writeFileSync(parsed.outPath, body, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(parsed.json ? body : formatFitTable(run));
  return 0;
}
