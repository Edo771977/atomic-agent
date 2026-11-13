import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "eval launcher with spaces "));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function launch(name: string, extra: Record<string, string> = {}) {
  const output = join(scratch, `${name}.json`);
  const result = spawnSync(process.execPath, [join(root, "eval-agents/fixtures/launcher.fixture.mjs")], {
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
