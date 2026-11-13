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
      expect(result.status, result.diagnostic).toBe(130);
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
