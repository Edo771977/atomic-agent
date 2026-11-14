// Shared daemon-lifecycle + vitest helpers for eval-agents orchestrators.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const CLI_BIN = resolve(REPO_ROOT, "dist", "cli", "index.js");
export const VITEST_CONFIG = resolve(REPO_ROOT, "eval-agents", "vitest.config.ts");

/**
 * The installed Vitest entry, resolved on use so that orchestrators and
 * helpers that never launch Vitest still load when it is not installed.
 */
export function resolveVitestEntry() {
  try {
    return fileURLToPath(import.meta.resolve("vitest/vitest.mjs"));
  } catch {
    throw new Error("vitest is not installed (cannot resolve vitest/vitest.mjs); run `npm ci` first");
  }
}
export const ENV_FILE = resolve(REPO_ROOT, "eval-agents", ".env");

export function makeLog(tag) {
  return (msg) => console.error(`[eval-agents:${tag}] ${msg}`);
}

export function loadEnv() {
  if (!existsSync(ENV_FILE)) return;
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (err) {
    console.error(`[eval-agents] failed to load ${ENV_FILE}: ${err?.message ?? err}`);
  }
}

export function runCli(args, { capture = false } = {}) {
  if (!existsSync(CLI_BIN)) {
    console.error("[eval-agents] dist/cli/index.js missing — run `npm run build` first");
    process.exit(2);
  }
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: REPO_ROOT,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function parseStatus(stdout) {
  const portMatch = stdout.match(/port\s+(\d+)|:(\d{4,5})/);
  return {
    port: portMatch ? Number(portMatch[1] ?? portMatch[2]) : null,
    health: stdout.match(/health:\s*(\S+)/)?.[1] ?? null,
  };
}

export async function probeUrl(url, timeoutMs = 2000, signal) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${url}/health`, { signal: signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal });
    return r.ok;
  } catch {
    signal?.throwIfAborted();
    return false;
  } finally {
    clearTimeout(t);
  }
}

export async function waitForHealth(url, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (await probeUrl(url, 2000, signal)) return;
    await delay(500, undefined, { signal });
  }
  throw new Error(`llama-server not healthy at ${url} in ${timeoutMs}ms`);
}

export async function bringUpDaemons(log, { signal } = {}) {
  signal?.throwIfAborted();
  if (process.env.ATOMIC_AGENT_EVAL_LLAMA_URL) {
    log(`ATOMIC_AGENT_EVAL_LLAMA_URL=${process.env.ATOMIC_AGENT_EVAL_LLAMA_URL}`);
    return {
      chatUrl: process.env.ATOMIC_AGENT_EVAL_LLAMA_URL,
      embedUrl: process.env.ATOMIC_AGENT_EVAL_EMBED_URL ?? null,
      startedByUs: false,
    };
  }

  const status0 = runCli(["models", "status"], { capture: true });
  if (status0.status !== 0) {
    log(`models status failed:\n${status0.stderr || status0.stdout}`);
    return { chatUrl: null, embedUrl: null, startedByUs: false };
  }
  const info = parseStatus(status0.stdout);
  if (!info.port) {
    log(`could not parse port:\n${status0.stdout}`);
    return { chatUrl: null, embedUrl: null, startedByUs: false };
  }

  const chatUrl = `http://127.0.0.1:${info.port}`;
  const startedByUs = info.health !== "up";
  if (startedByUs) {
    log("starting chat + embedding daemons (cold start may take 30-90s)...");
    const start = runCli(["models", "start"]);
    if (start.status !== 0) {
      log(`models start exited ${start.status}`);
      return { chatUrl: null, embedUrl: null, startedByUs: false };
    }
  } else {
    log(`reusing healthy chat daemon at ${chatUrl}`);
  }

  try {
    await waitForHealth(chatUrl, 120_000, signal);

    let embedUrl = null;
    for (const url of [
      process.env.ATOMIC_AGENT_EVAL_EMBED_URL,
      "http://127.0.0.1:19092",
      "http://127.0.0.1:18992",
    ].filter(Boolean)) {
      if (await probeUrl(url, 2000, signal)) {
        embedUrl = url;
        log(`embedding daemon at ${url}`);
        break;
      }
    }
    if (!embedUrl) log("no embedding daemon — atomic-agent runs FTS5-only memory");

    return { chatUrl, embedUrl, startedByUs };
  } catch (error) {
    teardownDaemons(log, startedByUs);
    throw error;
  }
}

export function teardownDaemons(log, startedByUs) {
  if (!startedByUs || process.env.ATOMIC_AGENT_EVAL_KEEP_DAEMON === "1") return;
  log("stopping managed daemons");
  try {
    runCli(["models", "stop"]);
  } catch {
    // best-effort
  }
}

export function runVitest({ extraEnv = {}, forwarded = [], signal,
  entryPath, cwd = REPO_ROOT,
  requireCampaign = entryPath === undefined, killTimeoutMs = 10_000 } = {}) {
  if (signal?.aborted) return Promise.resolve(signalExitCode(signal.reason?.signal));
  if (entryPath === undefined) {
    try {
      entryPath = resolveVitestEntry();
    } catch (error) {
      console.error(`[eval-agents] could not launch vitest: ${error.message}`);
      return Promise.resolve(1);
    }
  }
  const env = { ...process.env, ...extraEnv };
  let campaignPath;
  if (requireCampaign) {
    const reportDir = resolve(cwd, env.ATOMIC_AGENT_GAIA_REPORT_DIR || resolve(REPO_ROOT, "eval-agents", "reports",
      `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`));
    env.ATOMIC_AGENT_GAIA_REPORT_DIR = reportDir;
    campaignPath = resolve(reportDir, "campaign.json");
    mkdirSync(reportDir, { recursive: true });
    // Never let a previous run in an explicitly reused directory prove that
    // this invocation ran an agent. The campaign replaces this pending row.
    writeFileSync(campaignPath, `${JSON.stringify({ selected: null, executed: 0, status: "pending" })}\n`);
  }
  return new Promise((resolveExit) => {
    // POSIX: the child leads its own process group so cancellation reaches
    // Vitest's forked workers and the agents they started, not just Vitest's
    // main process. stdin is not inherited: a background process group must
    // not read the terminal.
    const child = spawn(
      process.execPath,
      [entryPath, "run", "--config", VITEST_CONFIG, ...forwarded],
      {
        cwd,
        env,
        stdio: ["ignore", "inherit", "inherit"],
        windowsHide: true,
        detached: process.platform !== "win32",
      },
    );
    let launchFailed = false;
    let interruptedBy = null;
    let killTimer;
    const tree = { child };
    trackTree(tree);
    const interrupt = (name) => {
      if (interruptedBy) return;
      interruptedBy = name;
      signalTree(child, name);
      // Escalate if the tree has not exited in time; close still awaits it.
      killTimer = setTimeout(() => signalTree(child, "SIGKILL"), killTimeoutMs);
      killTimer.unref?.();
    };
    const onAbort = () => interrupt(signal.reason?.signal ?? "SIGTERM");
    // Standalone callers forward process signals, without exiting before
    // close; a second signal kills the tree and exits immediately.
    const forwarders = new Map(CANCEL_SIGNALS.map((name) =>
      [name, () => (interruptedBy ? forceExit(name) : interrupt(name))]));
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    else for (const [name, listener] of forwarders) process.prependListener(name, listener);
    child.once("error", (error) => {
      launchFailed = true;
      if (!signal?.aborted) console.error(`[eval-agents] could not launch vitest: ${error.message}`);
    });
    // close follows both failed spawns and cancellation; wait until the child,
    // the rest of its process tree and its inherited streams have gone before
    // the caller tears down.
    child.once("close", async (code) => {
      signal?.removeEventListener("abort", onAbort);
      for (const [name, listener] of forwarders) process.removeListener(name, listener);
      await reapTree(child, killTimeoutMs);
      clearTimeout(killTimer);
      untrackTree(tree);
      let exitCode = signal?.aborted ? signalExitCode(signal.reason?.signal)
        : interruptedBy ? signalExitCode(interruptedBy) : launchFailed ? 1 : code ?? 1;
      if (exitCode === 0 && campaignPath) {
        try {
          const campaign = JSON.parse(readFileSync(campaignPath, "utf8"));
          if (!(campaign.executed > 0)) throw new Error("no GAIA agent cases executed");
        } catch (error) {
          console.error(`[eval-agents] invalid campaign completion: ${error.message}`);
          exitCode = 1;
        }
      }
      resolveExit(exitCode);
    });
  });
}

/**
 * Signals that cancel a campaign: Ctrl-C, termination, the terminal or SSH
 * session closing (SIGHUP) and Ctrl-\ (SIGQUIT, POSIX only; Windows has no
 * such signal and Node cannot listen for it there).
 */
const CANCEL_SIGNALS = process.platform === "win32"
  ? ["SIGINT", "SIGTERM", "SIGHUP"]
  : ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 };

/** Conventional shell exit status (128 + number) for a cancellation signal. */
export function signalExitCode(name) {
  return SIGNAL_EXIT_CODES[name] ?? 130;
}

// Test-child process trees still running; a second signal kills them all.
const activeTrees = new Set();

// While a tree runs, the launcher dying any other way — an uncaught
// exception, process.exit from elsewhere — must not orphan it: an exit
// listener kills it synchronously (only synchronous work runs on exit).
// A launcher killed with SIGKILL runs nothing; that case still leaks.
function killTreesOnExit() {
  for (const { child } of activeTrees) signalTree(child, "SIGKILL");
}

function trackTree(tree) {
  if (activeTrees.size === 0) process.on("exit", killTreesOnExit);
  activeTrees.add(tree);
}

function untrackTree(tree) {
  activeTrees.delete(tree);
  if (activeTrees.size === 0) process.removeListener("exit", killTreesOnExit);
}

// Synchronous teardowns an orchestrator registered (stopping a daemon it
// started, via spawnSync runCli); a forced exit skips its finally blocks.
const syncTeardowns = new Set();

/**
 * Register `fn` to run synchronously when a second signal forces the
 * launcher out, after the test trees are killed. Returns the unregister
 * function: call it before the normal teardown so the work runs once.
 */
export function registerSyncTeardown(fn) {
  syncTeardowns.add(fn);
  return () => { syncTeardowns.delete(fn); };
}

function forceExit(name) {
  for (const { child } of activeTrees) signalTree(child, "SIGKILL");
  for (const fn of [...syncTeardowns]) {
    syncTeardowns.delete(fn);
    try {
      fn();
    } catch (error) {
      console.error(`[eval-agents] teardown failed during forced exit: ${error?.message ?? error}`);
    }
  }
  process.exit(signalExitCode(name));
}

const defaultTreeDeps = {
  platform: process.platform,
  run: (command, args) => { spawnSync(command, args, { stdio: "ignore", windowsHide: true }); },
  kill: (pid, name) => { process.kill(pid, name); },
};

/**
 * Signal the test child's whole tree. POSIX: its process group. Windows:
 * `taskkill /T /F` whatever the signal — without /F taskkill only asks
 * windows to close, which a console Node process never receives, so a
 * graceful request would be ignored. /T walks the tree from the live
 * root; once the root has exited its orphaned descendants are not found.
 * `deps` is a test seam.
 */
export function signalTree(child, name, deps = defaultTreeDeps) {
  if (!child.pid) return;
  if (deps.platform === "win32") {
    deps.run("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    return;
  }
  try {
    deps.kill(-child.pid, name);
  } catch {
    // group already gone
  }
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    return error.code === "EPERM";
  }
  if (process.platform !== "linux") return true;
  // Zombies awaiting reaping by init still count for kill(); they are dead.
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      let stat;
      try { stat = readFileSync(`/proc/${entry}/stat`, "utf8"); } catch { continue; }
      const [state, , pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(pgrp) === pgid && state !== "Z") return true;
    }
    return false;
  } catch {
    return true;
  }
}

async function reapTree(child, timeoutMs) {
  if (!child.pid || process.platform === "win32") return;
  if (!groupAlive(child.pid)) return;
  // The main process exited but workers or agents remain: stop them too.
  signalTree(child, "SIGTERM");
  for (const [sig, budget] of [["SIGKILL", timeoutMs], [null, 2000]]) {
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      if (!groupAlive(child.pid)) return;
      await delay(50);
    }
    if (sig) signalTree(child, sig);
  }
}

export function installSignalHandlers(log) {
  const controller = new AbortController();
  const onSignal = (signal) => {
    if (controller.signal.aborted) {
      // A second signal means "stop now": kill running test trees and exit.
      log(`received ${signal} again, killing the test process tree`);
      forceExit(signal);
      return;
    }
    log(`received ${signal}, cancelling campaign`);
    controller.abort(Object.assign(new Error(`campaign cancelled by ${signal}`), { signal }));
  };
  const listeners = new Map(CANCEL_SIGNALS.map((name) => [name, () => onSignal(name)]));
  for (const [name, listener] of listeners) process.on(name, listener);
  return { signal: controller.signal,
    /** 129 SIGHUP, 130 SIGINT, 131 SIGQUIT, 143 SIGTERM; meaningful once aborted. */
    get exitCode() { return signalExitCode(controller.signal.reason?.signal); },
    dispose() {
    for (const [name, listener] of listeners) process.removeListener(name, listener);
  } };
}
