/**
 * How `models fit-test` swaps the user's local models for test models
 * and puts them back (ATO-1090, ATO-1498), including after a run that
 * was killed outright.
 *
 * The run writes a restore record (`<localModelsDataDir>/fit-test-restore.json`,
 * beside the managed daemon it is about, which several state dirs can
 * share through `dataDirOverride`: its pid, its state dir, the active
 * model, whether the chat and embedding daemons were up) before it
 * switches anything and removes it once the user's models
 * are back. A run killed without running a handler — the desktop's
 * Cancel on Windows is `TerminateProcess`, which no `process.on` hears —
 * leaves the record behind with a dead pid: the next `models` command or
 * TUI start (`recoverInterruptedFitTest`) puts the models back from it
 * and removes it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig, resetConfigCache } from "../config/index.js";
import type { LoadedFitModel } from "../fit-test/index.js";
import { getDaemonStatus, getEmbeddingDaemonStatus, readLaunchRecord, stopEmbeddingDaemon } from "../local-llm/index.js";
import { hasOtherLiveSessions } from "../local-llm/server/session-registry.js";
import {
  runLocalModelsStart,
  runLocalModelsStartEmbedding,
  runLocalModelsStop,
  runLocalModelsUse,
} from "./models-handlers.js";

/**
 * Runs a model handler with what it prints on stdout sent to stderr:
 * fit-test's stdout carries the report (`--json`), and a recovery runs
 * before another command's own output.
 */
export async function withStdoutOnStderr<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.stdout.write;
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = original;
  }
}

const stop = (opts: Parameters<typeof runLocalModelsStop>[0]) => withStdoutOnStderr(() => runLocalModelsStop(opts));
const use = (id: string) => withStdoutOnStderr(() => runLocalModelsUse(id));
const start = (opts: Parameters<typeof runLocalModelsStart>[0]) => withStdoutOnStderr(() => runLocalModelsStart(opts));
const startEmbedding = () => withStdoutOnStderr(() => runLocalModelsStartEmbedding());

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
 *
 * The user's model is put back suspended too: `models start` launches it
 * with this command's flags, not the TUI's or the desktop's (a growing
 * window, a fixed one, an offload shrink), and `--ctx-size` / `--parallel`
 * are in the cache fingerprint, so a normal start would delete the saves
 * the first stop just wrote. Its owner's next normal launch restores
 * them; a TUI starting beside it relaunches it for that
 * ({@link releaseSuspendedChatBeforeTui}).
 */
export function createFitModelSwitcher(
  snapshot: FitModelSnapshot,
  opts: { userCachesSaved?: boolean; onSwapped?: () => void } = {},
) {
  // A holder: the first stop saves the user's caches, no later one does.
  const state = { userCachesSaved: opts.userCachesSaved ?? false };
  const stopChat = async (): Promise<void> => {
    const savePromptCache = !state.userCachesSaved;
    state.userCachesSaved = true;
    await stop(savePromptCache ? { chatOnly: true } : { chatOnly: true, savePromptCache: false });
    // The user's model is down: from here on a test model may serve.
    if (savePromptCache) opts.onSwapped?.();
  };
  return {
    /** Makes `modelId` the active managed model and starts it. */
    async load(modelId: string, signal: AbortSignal): Promise<LoadedFitModel> {
      if (signal.aborted) throw new Error("stopped");
      await stopChat();
      if ((await use(modelId)) !== 0) throw new Error("unknown model id");
      if ((await start({ signal, promptCache: "suspend" })) !== 0) {
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
     * it is stopped first. `restart: false` leaves the chat model stopped
     * (a recovery before most `models` commands). `swapped: false` (a run
     * killed before the user's model was stopped) only puts the config
     * back if it moved; the user's model is never stopped.
     */
    async restore(stopped: boolean, restoreOpts: { restart?: boolean; swapped?: boolean } = {}): Promise<void> {
      const swapped = restoreOpts.swapped !== false;
      if (stopped && swapped) await stopChat();
      if (snapshot.previous !== null) {
        resetConfigCache();
        if (swapped || getConfig().localModels.managed.modelId !== snapshot.previous) await use(snapshot.previous);
        if (snapshot.chatRunning && restoreOpts.restart !== false && !(await chatDaemonStatus()).running) {
          await start({ promptCache: "suspend" });
        }
      }
      const embeddingNow = (await embeddingDaemonStatus().catch(() => ({ running: snapshot.embeddingRunning }))).running;
      if (snapshot.embeddingRunning && !embeddingNow) {
        await startEmbedding();
      } else if (!snapshot.embeddingRunning && embeddingNow) {
        // A test model's start brought it up. With no chat model to keep,
        // the full stop also lets an idle Atomic Core exit.
        if (snapshot.chatRunning) await stopEmbeddingDaemon(getConfig().paths.localModelsDataDir);
        else await stop({ savePromptCache: false });
      }
    },
  };
}

const MARKER_FILE = "fit-test-restore.json";
/** A record without a deadline (an older run's) is not live past this. */
const LEGACY_MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Budget per model load in {@link fitRunDeadlineMs}: a cold start of a big model. */
const LOAD_BUDGET_MS = 20 * 60 * 1000;
/** Budget per judge call (`fit-judge.ts` times out at 60 s). */
const JUDGE_BUDGET_MS = 60 * 1000;
const DEADLINE_MARGIN_MS = 30 * 60 * 1000;

/** The longest a run of `models` x `tasks` with this per-task timeout can take, with margin. */
export function fitRunDeadlineMs(models: number, tasks: number, timeoutMs: number): number {
  return models * (LOAD_BUDGET_MS + tasks * (timeoutMs + JUDGE_BUDGET_MS)) + DEADLINE_MARGIN_MS;
}

/**
 * When `pid` started, as an opaque token, or `null` where it cannot be
 * read: Linux `/proc/<pid>/stat` (start time in ticks since boot), macOS
 * `ps -o lstart=`. Windows has none without a slow WMI query; there the
 * record's deadline alone tells a reused pid apart.
 */
export function processStartToken(pid: number, platform: NodeJS.Platform = process.platform): string | null {
  try {
    if (platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Fields after the parenthesised command name; starttime is field 22.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19] ?? null;
    }
    if (platform === "darwin") {
      const out = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
      return out === "" ? null : out;
    }
  } catch {
    /* gone, or not readable */
  }
  return null;
}

export interface FitRestoreMarker extends FitModelSnapshot {
  pid: number;
  startedAt: number;
  /** When the run's process started ({@link processStartToken}); `null` where unreadable. */
  processStart?: string | null;
  /** Past this (epoch ms) the run is over, whatever process holds its pid now. */
  deadline?: number;
  /** The state dir whose config `previous` is (absent: the reader's own). */
  stateDir?: string;
  /**
   * The user's model was stopped and a test model may serve. Absent or
   * false: the run was killed before that, and the recovery must not stop
   * the daemon (it may be the user's own, still serving).
   */
  swapped?: boolean;
}

/** `dataDir` is the local models data dir (`paths.localModelsDataDir`). */
export function fitRestoreMarkerPath(dataDir: string): string {
  return join(dataDir, MARKER_FILE);
}

export function writeFitRestoreMarker(
  dataDir: string,
  snapshot: FitModelSnapshot,
  opts: { stateDir: string; maxRunMs: number; pid?: number },
): void {
  const pid = opts.pid ?? process.pid;
  const startedAt = Date.now();
  const marker: FitRestoreMarker = {
    pid,
    startedAt,
    processStart: processStartToken(pid),
    deadline: startedAt + opts.maxRunMs,
    stateDir: opts.stateDir,
    ...snapshot,
  };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(fitRestoreMarkerPath(dataDir), `${JSON.stringify(marker)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** Records that the user's model is down (`swapped`), keeping the rest of the record. */
export function markFitRestoreSwapped(dataDir: string): void {
  const marker = readFitRestoreMarker(dataDir);
  if (marker === null) return;
  writeFileSync(fitRestoreMarkerPath(dataDir), `${JSON.stringify({ ...marker, swapped: true })}\n`, { encoding: "utf8", mode: 0o600 });
}

export function clearFitRestoreMarker(dataDir: string): void {
  rmSync(fitRestoreMarkerPath(dataDir), { force: true });
}

/** The record, or `null` when there is none or it cannot be read as one. */
export function readFitRestoreMarker(dataDir: string): FitRestoreMarker | null {
  return readMarkerFile(fitRestoreMarkerPath(dataDir));
}

function readMarkerFile(path: string): FitRestoreMarker | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const m = raw as Partial<FitRestoreMarker> | null;
  if (
    m === null ||
    typeof m !== "object" ||
    !Number.isInteger(m.pid) ||
    typeof m.startedAt !== "number" ||
    !(m.previous === null || typeof m.previous === "string") ||
    typeof m.chatRunning !== "boolean" ||
    typeof m.embeddingRunning !== "boolean" ||
    !(m.stateDir === undefined || typeof m.stateDir === "string") ||
    !(m.swapped === undefined || typeof m.swapped === "boolean") ||
    !(m.processStart === undefined || m.processStart === null || typeof m.processStart === "string") ||
    !(m.deadline === undefined || typeof m.deadline === "number")
  ) {
    return null;
  }
  return m as FitRestoreMarker;
}

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM" || code === "EACCES";
  }
}

/**
 * Whether the record belongs to a fit-test that is still running: its pid
 * is alive and, where the start time can be read, started when the run's
 * did (a reused pid did not); where it cannot (Windows), the run's
 * deadline has not passed.
 */
export function fitRestoreMarkerLive(marker: FitRestoreMarker, now = Date.now()): boolean {
  if (!pidAlive(marker.pid)) return false;
  if (marker.pid === process.pid) return true;
  if (typeof marker.processStart === "string") {
    const current = processStartToken(marker.pid);
    if (current !== null) return current === marker.processStart;
  }
  return now < (marker.deadline ?? marker.startedAt + LEGACY_MARKER_MAX_AGE_MS);
}

/** Where a recovery moves the record while it acts on it: one command at a time. */
function claimPath(dataDir: string, pid = process.pid): string {
  return join(dataDir, `fit-test-restore.${pid}.claim`);
}
const CLAIM_NAME = /^fit-test-restore\.(\d+)\.claim$/;

/** Moves a claimed record back for the next recovery (unless a newer record took its place). */
function handBack(dataDir: string, claim: string): void {
  try {
    if (existsSync(fitRestoreMarkerPath(dataDir))) rmSync(claim, { force: true });
    else renameSync(claim, fitRestoreMarkerPath(dataDir));
  } catch {
    /* another recovery took it */
  }
}

/** A claim whose recovery was itself killed goes back to being the record. */
function releaseDeadClaims(dataDir: string): void {
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(CLAIM_NAME.exec(name)?.[1] ?? Number.NaN);
    if (!Number.isInteger(pid) || pid === process.pid || pidAlive(pid)) continue;
    handBack(dataDir, join(dataDir, name));
  }
}

/**
 * Put the models back from a killed fit-test's record, if one is left:
 * the test model stopped (nothing saved), the user's model active again
 * and, unless `restart` is false, started if it was running; the
 * embedding model as it was. Returns whether a record was acted on. A
 * record of a run still going is left alone; a failed restore keeps the
 * record for the next try. The record is claimed first (renamed to
 * `fit-test-restore.<pid>.claim`, atomic on one filesystem): of two
 * commands recovering at once, only the one whose rename succeeds acts.
 */
export async function recoverInterruptedFitTest(opts: { restart?: boolean } = {}): Promise<boolean> {
  const cfg = getConfig();
  const dataDir = cfg.paths.localModelsDataDir;
  releaseDeadClaims(dataDir);
  const seen = readFitRestoreMarker(dataDir);
  if (seen === null) {
    // An unreadable record helps nobody: drop it.
    clearFitRestoreMarker(dataDir);
    return false;
  }
  if (fitRestoreMarkerLive(seen)) return false;
  if (seen.stateDir !== undefined && resolve(seen.stateDir) !== resolve(cfg.paths.stateDir)) {
    // Its `previous` is another config's model: that config's next command puts it back.
    process.stderr.write(
      `an interrupted models fit-test of ${seen.stateDir} left a test model active; run an \`atomic-agent models\` command with that state dir to put its model back\n`,
    );
    return false;
  }
  const claim = claimPath(dataDir);
  try {
    renameSync(fitRestoreMarkerPath(dataDir), claim);
  } catch {
    return false; // another command claimed it first
  }
  // What was claimed may be a newer run's record, written since it was read.
  const marker = readMarkerFile(claim);
  if (marker === null || fitRestoreMarkerLive(marker)) {
    handBack(dataDir, claim);
    return false;
  }
  try {
    await restoreFromMarker(dataDir, marker, opts.restart !== false);
  } catch (err) {
    handBack(dataDir, claim);
    throw err;
  }
  rmSync(claim, { force: true });
  return true;
}

async function restoreFromMarker(dataDir: string, marker: FitRestoreMarker, restart: boolean): Promise<void> {
  // A test model may serve only once the user's was stopped (`swapped`),
  // and not if the daemon already serves the user's model again (the
  // restore ran and the run was killed before the record went).
  const status = await chatDaemonStatus();
  const serving = status.running ? (readLaunchRecord(dataDir, status.pid)?.modelId ?? null) : null;
  const swapped = marker.swapped === true && serving !== marker.previous;
  process.stderr.write(
    swapped
      ? "an interrupted models fit-test left a test model active; putting your model back\n"
      : "an interrupted models fit-test left its restore record; checking your model\n",
  );
  await createFitModelSwitcher(marker, { userCachesSaved: true }).restore(status.running, { restart, swapped });
  if (!restart && marker.chatRunning && marker.previous !== null && !(await chatDaemonStatus()).running) {
    process.stderr.write(`${marker.previous} starts again on next use (TUI, desktop app or \`atomic-agent models start\`)\n`);
  }
}

/**
 * Before the TUI adopts a running chat daemon: one launched with the
 * prompt disk cache suspended (a model `models fit-test` put back) while
 * the cache is on would serve the whole TUI session without saving its
 * conversations at the stop. It is stopped (nothing to save) so the TUI
 * launches it with its own window and restores the saves. Left alone
 * when the TUI would not use it (another provider, not managed), when
 * another session (the desktop, another TUI) holds it, or when it
 * already saves. Returns whether it was stopped.
 */
export async function releaseSuspendedChatBeforeTui(): Promise<boolean> {
  const cfg = getConfig();
  const active = cfg.llm?.activeTextProvider;
  if (cfg.localModels.mode !== "managed" || cfg.localModels.managed.promptDiskCache !== true) return false;
  if (active && active !== "local-llama") return false;
  const status = await chatDaemonStatus();
  if (!status.running) return false;
  const record = readLaunchRecord(cfg.paths.localModelsDataDir, status.pid);
  if (record === null || record.promptCacheFingerprint) return false;
  if (hasOtherLiveSessions(cfg.paths.localModelsDataDir)) return false;
  process.stderr.write("local model was started without its prompt cache (models fit-test); restarting it for this session\n");
  await stop({ chatOnly: true, savePromptCache: false });
  return true;
}
