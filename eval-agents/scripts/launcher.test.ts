import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "eval launcher with spaces "));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function launch(name: string, extra: Record<string, string> = {}, fixture = "launcher.fixture.mjs") {
  const output = join(scratch, `${name}.json`);
  const result = spawnSync(process.execPath, [join(root, "eval-agents/fixtures", fixture)], {
    cwd: root,
    env: { ...process.env, PATH: "", LAUNCHER_RESULT: output,
      LAUNCHER_ENTRY: join(root, "eval-agents/fixtures/launcher-entry.mjs"),
      LAUNCHER_CWD: scratch, ...extra },
    encoding: "utf8", timeout: 10_000,
  });
  if (result.error) throw result.error;
  return { ...result, output, diagnostic: `${result.stdout}\n${result.stderr}` };
}

describe("eval launcher actual Node children", () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    it(`lets the real installed ${signal} handler await child close and caller teardown`, () => {
      const result = launch(`handler-${signal}`, { LAUNCHER_MODE: "cancel", LAUNCHER_SIGNAL: signal }, "signal-orchestrator.fixture.mjs");
      expect(result.status, result.diagnostic).toBe(signal === "SIGTERM" ? 143 : 130);
      const events = readFileSync(`${result.output}.events.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line).event);
      expect(events).toEqual(["child-ready", "after-child-close", "teardown-finished", "returning"]);
      const child = JSON.parse(readFileSync(result.output, "utf8")) as { pid: number };
      expect(() => process.kill(child.pid, 0)).toThrow();
    });
  }
  it("uses the current Node and preserves forwarded argv without shell evaluation", () => {
    const args = ["-t", "two words", "& echo injected", "$(unsafe)", 'quote"inside', "trailing\\"];
    const result = launch("argv", { LAUNCHER_ARGS: JSON.stringify(args) });
    expect(result.status, result.diagnostic).toBe(0);
    expect(JSON.parse(readFileSync(result.output, "utf8"))).toMatchObject({
      execPath: process.execPath,
      args: ["run", "--config", join(root, "eval-agents/vitest.config.ts"), ...args],
      extra: "injected extra env",
    });
  });

  it("propagates the child's failure exit code", () => {
    const result = launch("exit", { LAUNCHER_EXIT: "7" });
    expect(result.status, result.diagnostic).toBe(7);
  });

  it("rejects a successful child that never records a campaign execution", () => {
    const result = launch("missing-campaign", { LAUNCHER_REQUIRE_CAMPAIGN: "1",
      ATOMIC_AGENT_GAIA_REPORT_DIR: join(scratch, "missing-campaign") });
    expect(result.status, result.diagnostic).toBe(1);
    expect(result.diagnostic).toContain("no GAIA agent cases executed");
  });

  it("uses one absolute report directory when caller and child working directories differ", () => {
    const result = launch("relative-report", { LAUNCHER_MODE: "campaign", LAUNCHER_REQUIRE_CAMPAIGN: "1",
      ATOMIC_AGENT_GAIA_REPORT_DIR: "relative-report" });
    expect(result.status, result.diagnostic).toBe(0);
    const child = JSON.parse(readFileSync(result.output, "utf8"));
    expect(child.reportDir).toBe(join(scratch, "relative-report"));
    expect(JSON.parse(readFileSync(join(scratch, "relative-report", "campaign.json"), "utf8"))).toMatchObject({ executed: 1 });
  });

  it("settles a spawn error with a diagnostic instead of an unhandled error", () => {
    const result = launch("spawn-error", { LAUNCHER_CWD: join(scratch, "nonexistent") });
    expect(result.status).toBe(1);
    expect(result.diagnostic).toContain("could not launch vitest");
    expect(result.diagnostic).not.toContain("Unhandled 'error' event");
  });

  it("waits for the cancelled child to close before resolving", () => {
    const result = launch("cancel", { LAUNCHER_MODE: "cancel" });
    expect(result.status, result.diagnostic).toBe(130);
    const child = JSON.parse(readFileSync(result.output, "utf8")) as { pid: number };
    expect(() => process.kill(child.pid, 0)).toThrow();
  });
});

// A zombie awaiting reaping by the container init is already dead.
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\)\s+/, "")[0] !== "Z"; } catch { return true; }
}

describe.skipIf(process.platform === "win32")("eval launcher process tree", () => {
  it("terminates grandchildren of the cancelled test child, not only its main process", () => {
    const result = launch("tree", { LAUNCHER_MODE: "tree" });
    const child = JSON.parse(readFileSync(result.output, "utf8")) as { pid: number; grandchildPid: number };
    try {
      expect(result.status, result.diagnostic).toBe(130);
      expect(processAlive(child.pid)).toBe(false);
      expect(processAlive(child.grandchildPid)).toBe(false);
    } finally {
      try { process.kill(child.grandchildPid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("escalates to SIGKILL when the tree ignores the termination signal", () => {
    const started = Date.now();
    const result = launch("stubborn", { LAUNCHER_MODE: "stubborn", LAUNCHER_KILL_TIMEOUT_MS: "500" });
    const child = JSON.parse(readFileSync(result.output, "utf8")) as { pid: number; grandchildPid: number };
    try {
      expect(result.status, result.diagnostic).toBe(130);
      expect(Date.now() - started).toBeLessThan(8000);
      expect(processAlive(child.pid)).toBe(false);
      expect(processAlive(child.grandchildPid)).toBe(false);
    } finally {
      for (const pid of [child.pid, child.grandchildPid]) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  });

  it("does not leave the test child's process group running after a normal exit", () => {
    const result = launch("leak", { LAUNCHER_MODE: "leak", LAUNCHER_KILL_TIMEOUT_MS: "500" });
    const child = JSON.parse(readFileSync(result.output, "utf8")) as { pid: number; grandchildPid: number };
    try {
      expect(result.status, result.diagnostic).toBe(0);
      expect(processAlive(child.grandchildPid)).toBe(false);
    } finally {
      try { process.kill(child.grandchildPid, "SIGKILL"); } catch { /* already gone */ }
    }
  });
});

describe.skipIf(process.platform === "win32")("eval launcher repeated signals", () => {
  for (const [first, second, code] of [["SIGINT", "SIGTERM", 143], ["SIGTERM", "SIGINT", 130]] as const) {
    it(`a second signal (${first} then ${second}) kills the tree and exits immediately with ${code}`, () => {
      const started = Date.now();
      const result = launch(`twice-${first}`, { LAUNCHER_MODE: "stubborn", LAUNCHER_SIGNAL: first,
        LAUNCHER_SECOND_SIGNAL: second, LAUNCHER_KILL_TIMEOUT_MS: "60000" }, "signal-orchestrator.fixture.mjs");
      const child = JSON.parse(readFileSync(result.output, "utf8")) as { pid: number; grandchildPid: number };
      try {
        expect(result.status, result.diagnostic).toBe(code);
        expect(Date.now() - started).toBeLessThan(8000);
        const events = readFileSync(`${result.output}.events.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line).event);
        expect(events).toEqual(["child-ready"]);
        const deadline = Date.now() + 2000;
        while ((processAlive(child.pid) || processAlive(child.grandchildPid)) && Date.now() < deadline) { /* SIGKILL delivery */ }
        expect(processAlive(child.pid)).toBe(false);
        expect(processAlive(child.grandchildPid)).toBe(false);
      } finally {
        for (const pid of [child.pid, child.grandchildPid]) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      }
    });
  }
});
