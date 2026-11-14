/**
 * `models fit-test` end to end with the model handlers and the daemon
 * status faked: what the run does to the user's model, prompt caches,
 * embedding daemon and output.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../config/index.js";
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
  Object.assign(fake, { chat: true, emb: false, embWanted: true, calls: [], duringTask: null });
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
    // Test models start without a save path, restore or purge; the user's comes back as usual.
    expect(callsOf("start")).toEqual([{ promptCache: "suspend" }, { promptCache: "suspend" }, { promptCache: null }]);
  });
});
