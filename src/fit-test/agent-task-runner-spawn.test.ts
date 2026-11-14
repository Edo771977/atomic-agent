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
