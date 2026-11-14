import { describe, expect, it } from "vitest";

import { signalTree } from "./_lib.mjs";

function recorder() {
  const runs: { command: string; args: string[] }[] = [];
  const kills: { pid: number; signal: string }[] = [];
  return {
    runs,
    kills,
    deps: (platform: NodeJS.Platform) => ({
      platform,
      run: (command: string, args: string[]) => { runs.push({ command, args }); },
      kill: (pid: number, signal: string) => { kills.push({ pid, signal }); },
    }),
  };
}

describe("signalTree", () => {
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"]) {
    it(`forces the whole tree with taskkill /T /F on Windows for ${name}`, () => {
      const r = recorder();
      signalTree({ pid: 4242 }, name, r.deps("win32"));
      expect(r.runs).toEqual([{ command: "taskkill", args: ["/pid", "4242", "/T", "/F"] }]);
      expect(r.kills).toEqual([]);
    });
  }

  it("signals the child's process group on POSIX", () => {
    const r = recorder();
    signalTree({ pid: 4242 }, "SIGTERM", r.deps("linux"));
    expect(r.kills).toEqual([{ pid: -4242, signal: "SIGTERM" }]);
    expect(r.runs).toEqual([]);
  });

  it("does nothing for a child that never started", () => {
    const r = recorder();
    signalTree({ pid: undefined }, "SIGTERM", r.deps("win32"));
    signalTree({ pid: undefined }, "SIGTERM", r.deps("linux"));
    expect(r.runs).toEqual([]);
    expect(r.kills).toEqual([]);
  });
});
