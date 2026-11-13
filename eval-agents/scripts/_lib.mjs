// Shared daemon-lifecycle + vitest helpers for eval-agents orchestrators.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const CLI_BIN = resolve(REPO_ROOT, "dist", "cli", "index.js");
export const VITEST_CONFIG = resolve(REPO_ROOT, "eval-agents", "vitest.config.ts");
export const VITEST_ENTRY = fileURLToPath(import.meta.resolve("vitest/vitest.mjs"));
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

export async function probeUrl(url, timeoutMs = 2000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`${url}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

export async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeUrl(url, 2000)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`llama-server not healthy at ${url} in ${timeoutMs}ms`);
}

export async function bringUpDaemons(log) {
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

  await waitForHealth(chatUrl, 120_000);

  let embedUrl = null;
  for (const url of [
    process.env.ATOMIC_AGENT_EVAL_EMBED_URL,
    "http://127.0.0.1:19092",
    "http://127.0.0.1:18992",
  ].filter(Boolean)) {
    if (await probeUrl(url)) {
      embedUrl = url;
      log(`embedding daemon at ${url}`);
      break;
    }
  }
  if (!embedUrl) log("no embedding daemon — atomic-agent runs FTS5-only memory");

  return { chatUrl, embedUrl, startedByUs };
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
  entryPath = VITEST_ENTRY, cwd = REPO_ROOT,
  requireCampaign = entryPath === VITEST_ENTRY } = {}) {
  const env = { ...process.env, ...extraEnv };
  let campaignPath;
  if (requireCampaign) {
    const reportDir = env.ATOMIC_AGENT_GAIA_REPORT_DIR ?? resolve(REPO_ROOT, "eval-agents", "reports",
      `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
    env.ATOMIC_AGENT_GAIA_REPORT_DIR = reportDir;
    campaignPath = resolve(reportDir, "campaign.json");
    mkdirSync(reportDir, { recursive: true });
    // Never let a previous run in an explicitly reused directory prove that
    // this invocation ran an agent. The campaign replaces this pending row.
    writeFileSync(campaignPath, `${JSON.stringify({ selected: null, executed: 0, status: "pending" })}\n`);
  }
  return new Promise((resolveExit) => {
    const child = spawn(
      process.execPath,
      [entryPath, "run", "--config", VITEST_CONFIG, ...forwarded],
      {
        cwd,
        env,
        stdio: "inherit",
        windowsHide: true,
        signal,
      },
    );
    let launchFailed = false;
    let interrupted = false;
    const forward = (name) => {
      interrupted = true;
      child.kill(name);
    };
    const onInt = () => forward("SIGINT");
    const onTerm = () => forward("SIGTERM");
    // Run before the orchestrator's daemon teardown/exit handler.
    process.prependListener("SIGINT", onInt);
    process.prependListener("SIGTERM", onTerm);
    child.once("error", (error) => {
      launchFailed = true;
      if (!signal?.aborted) console.error(`[eval-agents] could not launch vitest: ${error.message}`);
    });
    // close follows both failed spawns and cancellation; wait until the child
    // and its inherited streams have closed before the caller tears down.
    child.once("close", (code) => {
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
      let exitCode = signal?.aborted || interrupted ? 130 : launchFailed ? 1 : code ?? 1;
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

export function installSignalHandlers(log) {
  let cleaning = false;
  const onSignal = (signal) => {
    if (cleaning) return;
    cleaning = true;
    log(`received ${signal}, stopping daemons`);
    try {
      runCli(["models", "stop"]);
    } catch { /* noop */ }
    process.exit(130);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
}
