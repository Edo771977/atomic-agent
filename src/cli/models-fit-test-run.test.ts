/**
 * `models fit-test` end to end with the model handlers and the daemon
 * status faked: what the run does to the user's model, prompt caches,
 * embedding daemon and output.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, resetConfigCache } from "../config/index.js";
import { USER_CONFIG_VERSION } from "../config/config-schema.js";
import { FIT_TASK_SET_KIND, FIT_TASK_SET_VERSION } from "../fit-test/fit-task.js";

type Call = [string, Record<string, unknown> | string | null];

const fake = vi.hoisted(() => ({
  /** The chat daemon is up. */
  chat: true,
  /** The embedding daemon is up. */
  emb: false,
  /** The config asks for an embedding model (`embeddingModelWanted`). */
  embWanted: true,
  calls: [] as Array<[string, Record<string, unknown> | string | null]>,
  duringTask: null as null | (() => void),
  /** `models use <id>` of this id throws (a restore that fails). */
  useThrowsFor: null as string | null,
  /** The running chat daemon's launch record (`readLaunchRecord`). */
  launch: null as null | { modelId: string; promptCacheFingerprint: string | null },
}));

vi.mock("./models-handlers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./models-handlers.js")>();
  return {
    ...actual,
    // Like the real handlers, each one reports on stdout.
    runLocalModelsStop: vi.fn(async (opts?: Record<string, unknown>) => {
      fake.calls.push(["stop", opts ?? {}]);
      fake.chat = false;
      if (!(opts?.chatOnly === true && fake.embWanted)) fake.emb = false;
      process.stdout.write("stopped\n");
      return 0;
    }),
    runLocalModelsUse: vi.fn(async (id: string) => {
      fake.calls.push(["use", id]);
      if (fake.useThrowsFor === id) throw new Error("config is read-only");
      process.stdout.write(`mode: managed\nactive model: ${id}\n`);
      return 0;
    }),
    runLocalModelsStart: vi.fn(async (opts?: Record<string, unknown>) => {
      fake.calls.push(["start", { promptCache: opts?.promptCache ?? null }]);
      fake.chat = true;
      if (fake.embWanted) fake.emb = true;
      process.stdout.write("chat: started pid 77, healthy on port 1\n");
      return 0;
    }),
    runLocalModelsStartEmbedding: vi.fn(async () => {
      fake.calls.push(["start-embedding", null]);
      fake.emb = true;
      process.stdout.write("embedding: started\n");
      return 0;
    }),
    runLocalModelsStatus: vi.fn(async () => {
      fake.calls.push(["status", null]);
      return 0;
    }),
  };
});

vi.mock("../local-llm/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../local-llm/index.js")>();
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ running: fake.chat, pid: fake.chat ? 77 : null })),
    readLaunchRecord: vi.fn((_dir: string, pid: number | null) => (pid === null ? null : fake.launch)),
    getEmbeddingDaemonStatus: vi.fn(async () => ({ running: fake.emb, pid: fake.emb ? 78 : null })),
    stopEmbeddingDaemon: vi.fn(async () => {
      fake.calls.push(["stop-embedding", null]);
      fake.emb = false;
    }),
  };
});

vi.mock("../local-llm/model-upgrade-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../local-llm/model-upgrade-runner.js")>()),
  readRecommendSnapshot: vi.fn(async () => Promise.reject(new Error("no snapshot"))),
}));

vi.mock("../fit-test/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../fit-test/index.js")>();
  return {
    ...actual,
    createAgentTaskRunner: () => async () => {
      fake.duringTask?.();
      return { reply: "done", durationMs: 1, tokens: null, timedOut: false, error: null };
    },
    createFitJudge: () => async () => ({ score: 5, reason: "fine" }),
    readProcessRssBytes: async () => null,
  };
});

import { runModelsFitTest } from "./models-fit-test-command.js";
import { modelsCommand } from "./models-command.js";
import {
  fitRestoreMarkerLive,
  processStartToken,
  recoverInterruptedFitTest,
  releaseSuspendedChatBeforeTui,
} from "./models-fit-test-restore.js";

let stateDir: string;
let tasksPath: string;
let stdout: string;
let stderr: string;
const savedStateDir = process.env.ATOMIC_AGENT_STATE_DIR;
const savedParent = process.env.ATOMIC_AGENT_SESSION_PARENT_PID;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "atomic-fit-cmd-"));
  process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
  delete process.env.ATOMIC_AGENT_SESSION_PARENT_PID;
  writeFileSync(
    join(stateDir, "config.json"),
    JSON.stringify({ version: USER_CONFIG_VERSION, localModels: { mode: "managed", managed: { modelId: "qwen-3.5-4b" } } }),
  );
  resetConfigCache();
  tasksPath = join(stateDir, "tasks.json");
  writeFileSync(
    tasksPath,
    JSON.stringify({
      kind: FIT_TASK_SET_KIND,
      version: FIT_TASK_SET_VERSION,
      createdAt: "2026-11-12T00:00:00.000Z",
      tasks: [
        {
          id: "t1",
          name: "t1",
          category: "os",
          prompt: "list files",
          expectations: [{ kind: "judge", rubric: "r" }],
          source: { sessionId: "s", at: 1, toolsUsed: [], referenceReply: "ok" },
        },
      ],
    }),
  );
  Object.assign(fake, { chat: true, emb: false, embWanted: true, calls: [], duringTask: null, useThrowsFor: null, launch: null });
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedStateDir === undefined) delete process.env.ATOMIC_AGENT_STATE_DIR;
  else process.env.ATOMIC_AGENT_STATE_DIR = savedStateDir;
  if (savedParent === undefined) delete process.env.ATOMIC_AGENT_SESSION_PARENT_PID;
  else process.env.ATOMIC_AGENT_SESSION_PARENT_PID = savedParent;
  resetConfigCache();
  rmSync(stateDir, { recursive: true, force: true });
});

function fitArgs(...extra: string[]): string[] {
  return ["--tasks", tasksPath, "--models", "qwen-3.5-2b,qwen-3.5-9b", "--judge-url", "http://127.0.0.1:1", ...extra];
}

function callsOf(name: string): Array<Call[1]> {
  return fake.calls.filter(([n]) => n === name).map(([, opts]) => opts);
}

describe("models fit-test and the user's prompt caches", () => {
  it("saves the user's model once, then runs the test models with the disk cache suspended", async () => {
    expect(await runModelsFitTest(fitArgs())).toBe(0);
    const stops = callsOf("stop") as Array<Record<string, unknown>>;
    // The first stop is the user's own model: its conversations are saved.
    expect(stops[0]?.savePromptCache).not.toBe(false);
    // Every later stop is a test model's (or the restore's): nothing saved.
    expect(stops.length).toBeGreaterThan(1);
    for (const stop of stops.slice(1)) expect(stop.savePromptCache).toBe(false);
    // Test models start without a save path, restore or purge. So does the
    // user's model when it is put back: `models start` launches it with
    // other flags than the TUI's or the desktop's launch (growing window,
    // offload shrink), and a normal start would delete the saves the first
    // stop just wrote as a fingerprint mismatch. Its owner's next normal
    // launch restores them.
    expect(callsOf("start")).toEqual([{ promptCache: "suspend" }, { promptCache: "suspend" }, { promptCache: "suspend" }]);
  });
});

describe("models fit-test and the embedding daemon", () => {
  it("keeps memory search up when only the embedding model was running", async () => {
    Object.assign(fake, { chat: false, emb: true });
    expect(await runModelsFitTest(fitArgs())).toBe(0);
    expect(fake.emb).toBe(true);
    expect(fake.chat).toBe(false);
    for (const stop of callsOf("stop") as Array<Record<string, unknown>>) expect(stop.chatOnly).toBe(true);
  });

  it("leaves the embedding model down when it was down before the run", async () => {
    Object.assign(fake, { chat: false, emb: false });
    expect(await runModelsFitTest(fitArgs())).toBe(0);
    expect(fake.emb).toBe(false);
    expect(fake.chat).toBe(false);
  });

  it("brings both back when both were running", async () => {
    Object.assign(fake, { chat: true, emb: true });
    expect(await runModelsFitTest(fitArgs())).toBe(0);
    expect(fake.emb).toBe(true);
    expect(fake.chat).toBe(true);
  });
});

/** The restore record, beside the managed daemon it is about. */
function markerFile(): string {
  return join(getConfig().paths.localModelsDataDir, "fit-test-restore.json");
}

function writeMarker(marker: Record<string, unknown>): void {
  mkdirSync(getConfig().paths.localModelsDataDir, { recursive: true });
  writeFileSync(markerFile(), JSON.stringify(marker));
}

/** A pid that has already exited: a fit-test the desktop's Cancel killed. */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

describe("models fit-test restore marker (killed without a signal handler, e.g. Windows Cancel)", () => {
  const markerPath = markerFile;

  it("records the user's models before switching and removes the record once they are back", async () => {
    Object.assign(fake, { chat: true, emb: true });
    let seen: unknown = null;
    fake.duringTask = () => {
      seen = existsSync(markerPath()) ? JSON.parse(readFileSync(markerPath(), "utf8")) : null;
    };
    expect(await runModelsFitTest(fitArgs())).toBe(0);
    // `swapped`: the user's model was stopped (and its caches saved) before the task ran.
    expect(seen).toMatchObject({ pid: process.pid, previous: "qwen-3.5-4b", chatRunning: true, embeddingRunning: true, swapped: true });
    expect(existsSync(markerPath())).toBe(false);
  });

  it("the next models command puts the user's model back, starts it again and clears the record", async () => {
    writeMarker({ pid: deadPid(), startedAt: Date.now(), previous: "qwen-3.5-4b", chatRunning: true, embeddingRunning: true, swapped: true });
    // The killed run left a test model serving, beside the embedding model.
    Object.assign(fake, { chat: true, emb: true });
    expect(await modelsCommand(["status"])).toBe(0);
    expect(fake.calls.map(([name]) => name)).toEqual(["stop", "use", "start", "status"]);
    expect(callsOf("stop")[0]).toMatchObject({ chatOnly: true, savePromptCache: false });
    expect(callsOf("use")).toEqual(["qwen-3.5-4b"]);
    expect(callsOf("start")).toEqual([{ promptCache: "suspend" }]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("`models stop` after a killed run puts the model back in config without starting it", async () => {
    writeMarker({ pid: deadPid(), startedAt: Date.now(), previous: "qwen-3.5-4b", chatRunning: true, embeddingRunning: false, swapped: true });
    Object.assign(fake, { chat: true, emb: false });
    await modelsCommand(["stop"]);
    expect(callsOf("use")).toEqual(["qwen-3.5-4b"]);
    expect(callsOf("start")).toEqual([]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("leaves the record of a fit-test that is still running alone", async () => {
    writeMarker({ pid: process.ppid, startedAt: Date.now(), previous: "qwen-3.5-4b", chatRunning: true, embeddingRunning: false });
    expect(await modelsCommand(["status"])).toBe(0);
    expect(fake.calls.map(([name]) => name)).toEqual(["status"]);
    expect(existsSync(markerPath())).toBe(true);
  });
});

describe("models fit-test --json", () => {
  it("prints the run alone on stdout: the model handlers' lines go to stderr", async () => {
    expect(await runModelsFitTest(fitArgs("--json"))).toBe(0);
    const run = JSON.parse(stdout) as { kind: string; models: Array<{ modelId: string }> };
    expect(run.kind).toBe("atomic-agent.fit-test-run");
    expect(run.models.map((m) => m.modelId)).toEqual(["qwen-3.5-2b", "qwen-3.5-9b"]);
    expect(stderr).toContain("stopped");
    expect(stderr).toContain("active model: qwen-3.5-4b");
  });
});

describe("models fit-test beside another client of the local model", () => {
  it("refuses while a TUI or the desktop holds the local model, touching nothing", async () => {
    const sessions = join(getConfig().paths.localModelsDataDir, "sessions");
    mkdirSync(sessions, { recursive: true });
    // A live process other than this one: the test runner's parent.
    writeFileSync(join(sessions, String(process.ppid)), String(process.ppid));
    expect(await runModelsFitTest(fitArgs())).toBe(1);
    expect(stderr).toMatch(/another atomic-agent session is using the local model/);
    expect(fake.calls).toEqual([]);
    expect(stdout).toBe("");
  });

  it("refuses while another fit-test is running", async () => {
    writeMarker({ pid: process.ppid, startedAt: Date.now(), previous: "qwen-3.5-4b", chatRunning: true, embeddingRunning: false });
    expect(await runModelsFitTest(fitArgs())).toBe(1);
    expect(stderr).toMatch(/another models fit-test is running/);
    expect(fake.calls).toEqual([]);
    expect(existsSync(markerFile())).toBe(true);
  });
});

describe("models fit-test when putting the user's model back fails", () => {
  it("still prints the finished report, reports the failure and keeps the record for the next command", async () => {
    fake.useThrowsFor = "qwen-3.5-4b";
    expect(await runModelsFitTest(fitArgs("--json"))).toBe(1);
    const run = JSON.parse(stdout) as { kind: string };
    expect(run.kind).toBe("atomic-agent.fit-test-run");
    expect(stderr).toMatch(/putting your model back failed: config is read-only/);
    expect(existsSync(markerFile())).toBe(true);
  });
});

describe("a TUI starting beside a model fit-test put back with its cache suspended", () => {
  function cacheOn(on: boolean): void {
    writeFileSync(
      join(stateDir, "config.json"),
      JSON.stringify({
        version: USER_CONFIG_VERSION,
        localModels: { mode: "managed", managed: { modelId: "qwen-3.5-4b", promptDiskCache: on } },
      }),
    );
    resetConfigCache();
  }

  it("stops the suspended daemon so the TUI launches it with its own window and its saves", async () => {
    cacheOn(true);
    fake.launch = { modelId: "qwen-3.5-4b", promptCacheFingerprint: null };
    expect(await releaseSuspendedChatBeforeTui()).toBe(true);
    expect(callsOf("stop")).toEqual([{ chatOnly: true, savePromptCache: false }]);
  });

  it("adopts a daemon that saves its caches, or any daemon when the cache is off", async () => {
    cacheOn(true);
    fake.launch = { modelId: "qwen-3.5-4b", promptCacheFingerprint: "fp" };
    expect(await releaseSuspendedChatBeforeTui()).toBe(false);
    cacheOn(false);
    fake.launch = { modelId: "qwen-3.5-4b", promptCacheFingerprint: null };
    expect(await releaseSuspendedChatBeforeTui()).toBe(false);
    expect(callsOf("stop")).toEqual([]);
  });

  it("leaves it to a desktop or another TUI that holds it", async () => {
    cacheOn(true);
    fake.launch = { modelId: "qwen-3.5-4b", promptCacheFingerprint: null };
    const sessions = join(getConfig().paths.localModelsDataDir, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, String(process.ppid)), String(process.ppid));
    expect(await releaseSuspendedChatBeforeTui()).toBe(false);
    expect(callsOf("stop")).toEqual([]);
  });
});

describe("the restore record lives beside the managed daemon", () => {
  it("is written in the local models data dir, with the state dir whose config it restores", async () => {
    const shared = mkdtempSync(join(tmpdir(), "atomic-fit-models-"));
    try {
      writeFileSync(
        join(stateDir, "config.json"),
        JSON.stringify({
          version: USER_CONFIG_VERSION,
          localModels: { mode: "managed", managed: { modelId: "qwen-3.5-4b", dataDirOverride: shared } },
        }),
      );
      resetConfigCache();
      let seen: unknown = null;
      fake.duringTask = () => {
        const at = join(shared, "fit-test-restore.json");
        seen = existsSync(at) ? JSON.parse(readFileSync(at, "utf8")) : null;
      };
      expect(await runModelsFitTest(fitArgs())).toBe(0);
      expect(seen).toMatchObject({ pid: process.pid, stateDir, previous: "qwen-3.5-4b" });
      expect(existsSync(join(stateDir, "fit-test-restore.json"))).toBe(false);
    } finally {
      rmSync(shared, { recursive: true, force: true });
    }
  });

  it("a command of another state dir sharing the daemon leaves that config alone", async () => {
    writeMarker({
      pid: deadPid(),
      startedAt: Date.now(),
      stateDir: join(tmpdir(), "another-state-dir"),
      previous: "qwen-3.5-4b",
      chatRunning: true,
      embeddingRunning: false,
      swapped: true,
    });
    expect(await modelsCommand(["status"])).toBe(0);
    expect(callsOf("use")).toEqual([]);
    expect(stderr).toMatch(/another-state-dir/);
    expect(existsSync(markerFile())).toBe(true);
  });
});

describe("recovering a fit-test killed before it swapped the model", () => {
  it("a record without `swapped` never stops the user's model, still running", async () => {
    // Killed during the first stop: the user's own model may still serve.
    writeMarker({ pid: deadPid(), startedAt: Date.now(), previous: "qwen-3.5-4b", chatRunning: true, embeddingRunning: false });
    fake.launch = { modelId: "qwen-3.5-4b", promptCacheFingerprint: "fp" };
    expect(await modelsCommand(["status"])).toBe(0);
    expect(fake.calls.map(([name]) => name)).toEqual(["status"]);
    expect(existsSync(markerFile())).toBe(false);
  });

  it("a swapped record whose daemon already serves the user's model leaves it running", async () => {
    // Killed after the restore started the user's model, before the record went.
    writeMarker({ pid: deadPid(), startedAt: Date.now(), previous: "qwen-3.5-4b", chatRunning: true, embeddingRunning: false, swapped: true });
    fake.launch = { modelId: "qwen-3.5-4b", promptCacheFingerprint: null };
    expect(await modelsCommand(["status"])).toBe(0);
    expect(callsOf("stop")).toEqual([]);
    expect(callsOf("start")).toEqual([]);
    expect(existsSync(markerFile())).toBe(false);
  });
});

describe("a restore record whose pid the OS handed to another process", () => {
  const base = { previous: "qwen-3.5-4b", chatRunning: true, embeddingRunning: false, swapped: true };

  it("records this process's start and a deadline from the run's own length", async () => {
    let seen: Record<string, unknown> | null = null;
    fake.duringTask = () => {
      seen = JSON.parse(readFileSync(markerFile(), "utf8")) as Record<string, unknown>;
    };
    expect(await runModelsFitTest(fitArgs("--timeout", "60"))).toBe(0);
    const marker = seen as unknown as { processStart: string | null; deadline: number; startedAt: number };
    if (process.platform === "linux" || process.platform === "darwin") expect(marker.processStart).toBe(processStartToken(process.pid));
    // Two models, one task of 60 s: well under the old 24 h.
    expect(marker.deadline - marker.startedAt).toBeLessThan(3 * 60 * 60 * 1000);
    expect(marker.deadline - marker.startedAt).toBeGreaterThan(2 * 60 * 1000);
  });

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "a live pid that started at another time is not the run",
    () => {
      const now = Date.now();
      expect(fitRestoreMarkerLive({ ...base, pid: process.ppid, startedAt: now, deadline: now + 60_000, processStart: "not-its-start" })).toBe(false);
      expect(
        fitRestoreMarkerLive({ ...base, pid: process.ppid, startedAt: now, deadline: now + 60_000, processStart: processStartToken(process.ppid) }),
      ).toBe(true);
    },
  );

  it("without a start time, a live pid past the run's deadline is not the run (Windows)", () => {
    const now = Date.now();
    expect(fitRestoreMarkerLive({ ...base, pid: process.ppid, startedAt: now - 7_200_000, deadline: now - 1, processStart: null }, now)).toBe(false);
    expect(fitRestoreMarkerLive({ ...base, pid: process.ppid, startedAt: now - 1000, deadline: now + 60_000, processStart: null }, now)).toBe(true);
  });
});

describe("two commands recovering the same killed fit-test at once", () => {
  const killed = (): Record<string, unknown> => ({
    pid: deadPid(),
    startedAt: Date.now(),
    previous: "qwen-3.5-4b",
    chatRunning: true,
    embeddingRunning: false,
    swapped: true,
  });

  it("only the one that claims the record puts the model back", async () => {
    writeMarker(killed());
    const results = await Promise.all([recoverInterruptedFitTest({ restart: false }), recoverInterruptedFitTest({ restart: false })]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(callsOf("use")).toEqual(["qwen-3.5-4b"]);
    expect(callsOf("stop")).toHaveLength(1);
    expect(readdirSync(getConfig().paths.localModelsDataDir).filter((n) => n.startsWith("fit-test-restore"))).toEqual([]);
  });

  it("a claim left by a recovery that was itself killed is taken up again", async () => {
    mkdirSync(getConfig().paths.localModelsDataDir, { recursive: true });
    const dead = deadPid();
    writeFileSync(join(getConfig().paths.localModelsDataDir, `fit-test-restore.${dead}.claim`), JSON.stringify(killed()));
    expect(await recoverInterruptedFitTest({ restart: false })).toBe(true);
    expect(callsOf("use")).toEqual(["qwen-3.5-4b"]);
    expect(readdirSync(getConfig().paths.localModelsDataDir).filter((n) => n.startsWith("fit-test-restore"))).toEqual([]);
  });

  it("a failed recovery hands the record back for the next try", async () => {
    writeMarker(killed());
    fake.useThrowsFor = "qwen-3.5-4b";
    await expect(recoverInterruptedFitTest({ restart: false })).rejects.toThrow(/read-only/);
    expect(existsSync(markerFile())).toBe(true);
    expect(readdirSync(getConfig().paths.localModelsDataDir).filter((n) => n.endsWith(".claim"))).toEqual([]);
  });
});
