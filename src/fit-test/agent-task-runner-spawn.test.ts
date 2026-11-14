/**
 * The child `atomic-agent run` a fit-test task spawns, with `spawn`
 * faked: how it is stopped and what it inherits.
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

import type { FitTask } from "./fit-task.js";
import { createAgentTaskRunner } from "./agent-task-runner.js";

const TASK: FitTask = {
  id: "t1",
  name: "t1",
  category: "os",
  prompt: "list files",
  expectations: [{ kind: "judge", rubric: "r" }],
  source: { sessionId: "s", at: 1, toolsUsed: [], referenceReply: "ok" },
};

type FakeProcess = EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: (text?: string) => void };
  kill: ReturnType<typeof vi.fn>;
};

function fakeProcess(pid: number): FakeProcess {
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { end: () => {} },
    kill: vi.fn(() => true),
  });
  // A signal at the one pid ends it (and, on Windows, not its children).
  child.kill.mockImplementation(() => {
    setTimeout(() => child.emit("close", null), 1);
    return true;
  });
  return child;
}

afterEach(() => {
  spawnMock.mockReset();
});

describe("stopping a fit-test task's child", () => {
  it("on Windows stops the whole tree with taskkill by absolute path, not the one pid", async () => {
    const agent = fakeProcess(4321);
    const taskkill = fakeProcess(4322);
    spawnMock.mockImplementation((cmd: string) => {
      if (cmd.toLowerCase().endsWith("taskkill.exe")) {
        // taskkill walked the tree: the agent goes, then taskkill reports 0.
        setTimeout(() => {
          agent.emit("close", 1);
          taskkill.emit("close", 0);
        }, 1);
        return taskkill;
      }
      return agent;
    });
    const controller = new AbortController();
    const run = createAgentTaskRunner({
      modelUrl: "http://127.0.0.1:1",
      modelApiKey: null,
      timeoutMs: 60_000,
      signal: controller.signal,
      platform: "win32",
    });
    const pending = run(TASK);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const outcome = await pending;
    expect(outcome.error).toBe("stopped");
    const kill = spawnMock.mock.calls.find(([cmd]) => String(cmd).toLowerCase().endsWith("taskkill.exe"));
    expect(kill).toBeDefined();
    expect(String(kill?.[0])).toMatch(/^[A-Za-z]:\\.*\\System32\\taskkill\.exe$/i);
    expect(kill?.[1]).toEqual(["/PID", "4321", "/T"]);
    expect(agent.kill).not.toHaveBeenCalled();
  });
});

describe("what a fit-test task's child inherits", () => {
  const planted = {
    GITHUB_TOKEN: "ghp_planted",
    COMPOSIO_API_KEY: "composio-planted",
    OPENAI_API_KEY: "sk-planted",
    ATOMIC_MAIL_API_KEY: "mail-planted",
  };

  afterEach(() => {
    for (const name of Object.keys(planted)) delete process.env[name];
    delete process.env.ATOMIC_AGENT_LLAMA_API_KEY;
  });

  it("drops the parent's credentials but passes the loaded model's key and the temp state dir", async () => {
    Object.assign(process.env, planted, { ATOMIC_AGENT_LLAMA_API_KEY: "the-operator-key" });
    let env: NodeJS.ProcessEnv = {};
    spawnMock.mockImplementation((_cmd: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      env = options.env;
      const child = fakeProcess(4400);
      setTimeout(() => child.emit("close", 0), 1);
      return child;
    });
    const run = createAgentTaskRunner({ modelUrl: "http://127.0.0.1:1", modelApiKey: "managed-key", timeoutMs: 60_000 });
    await run(TASK);
    for (const name of Object.keys(planted)) expect(env[name]).toBeUndefined();
    expect(env.ATOMIC_AGENT_LLAMA_API_KEY).toBe("managed-key");
    expect(env.ATOMIC_AGENT_STATE_DIR).toMatch(/atomic-fit-/);
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("drops the parent's agent and browser settings, keeping only the asset paths the child needs", async () => {
    const parent = {
      ATOMIC_AGENT_BROWSER_CDP_URL: "ws://127.0.0.1:9222/devtools/browser/x",
      ATOMIC_AGENT_BROWSER_EXECUTABLE_PATH: "/opt/chrome",
      ATOMIC_AGENT_LLAMA_URL: "http://127.0.0.1:9999",
      ATOMIC_AGENT_SESSION_PARENT_PID: "4242",
      ATOMIC_AGENT_KEY_MY_VPS: "ssh-planted",
      PLAYWRIGHT_BROWSERS_PATH: "/opt/pw",
      CHROME_PATH: "/opt/chrome",
      ATOMIC_AGENT_GRAMMARS_DIR: "/opt/atag/grammars",
      ATOMIC_AGENT_RG_PATH: "/opt/atag/rg",
    };
    const saved = Object.fromEntries(Object.keys(parent).map((k) => [k, process.env[k]]));
    Object.assign(process.env, parent);
    try {
      let env: NodeJS.ProcessEnv = {};
      spawnMock.mockImplementation((_cmd: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        env = options.env;
        const child = fakeProcess(4401);
        setTimeout(() => child.emit("close", 0), 1);
        return child;
      });
      await createAgentTaskRunner({ modelUrl: "http://127.0.0.1:1", modelApiKey: null, timeoutMs: 60_000 })(TASK);
      for (const name of [
        "ATOMIC_AGENT_BROWSER_CDP_URL",
        "ATOMIC_AGENT_BROWSER_EXECUTABLE_PATH",
        "ATOMIC_AGENT_LLAMA_URL",
        "ATOMIC_AGENT_SESSION_PARENT_PID",
        "ATOMIC_AGENT_KEY_MY_VPS",
        "PLAYWRIGHT_BROWSERS_PATH",
        "CHROME_PATH",
      ]) {
        expect(env[name], name).toBeUndefined();
      }
      expect(env.ATOMIC_AGENT_GRAMMARS_DIR).toBe("/opt/atag/grammars");
      expect(env.ATOMIC_AGENT_RG_PATH).toBe("/opt/atag/rg");
      // The replay is not the user's activity.
      expect(env.ATOMIC_AGENT_ANALYTICS).toBe("off");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
