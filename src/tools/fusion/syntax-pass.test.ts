import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifySyntax } from "../verify/verify-syntax.js";
import {
  describeSyntax,
  runSyntaxPass,
  SYNTAX_OUTPUT_CHARS,
  type SyntaxCheckRunner,
} from "./syntax-pass.js";
import { formatDelegateOutput, type WorkerTaskResult } from "./worker-result.js";

function row(overrides: Partial<WorkerTaskResult> = {}): WorkerTaskResult {
  return {
    id: "t1",
    title: "Task",
    status: "ok",
    reply: "STATUS: done",
    stepCount: 3,
    durationMs: 1000,
    tools: { calls: 2, errors: 0, writes: 1, byTool: {} },
    ...overrides,
  };
}

const realRunner: SyntaxCheckRunner = (files, dir) => verifySyntax(files, dir);

describe("runSyntaxPass", () => {
  let dir: string;
  const signal = new AbortController().signal;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-syntax-pass-"));
    writeFileSync(join(dir, "good.js"), "export const a = 1;\n");
    writeFileSync(join(dir, "bad.js"), "const = ;\n");
    writeFileSync(join(dir, "notes.txt"), "plain\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("checks a green row's changed files and says so", async () => {
    const [out] = await runSyntaxPass(
      [row({ changes: [{ path: "good.js", kind: "new", addedLines: 1, removedLines: 0 }] })],
      [{ id: "t1", title: "Task", instructions: "x" }],
      { runner: realRunner, workingDir: dir, roots: [dir], signal },
    );
    expect(out!.status).toBe("ok");
    expect(out!.syntax).toEqual({ checked: 1, failedFiles: [], unchecked: 0 });
    const table = formatDelegateOutput([out!], 8000).split("\n\n")[0]!;
    expect(table).toContain("syntax ok (1 file)");
  });

  it("demotes a row whose changed file fails, with a bounded snippet in its block", async () => {
    const [out] = await runSyntaxPass(
      [
        row({
          changes: [
            { path: "good.js", kind: "modified", addedLines: 1, removedLines: 0 },
            { path: "bad.js", kind: "new", addedLines: 1, removedLines: 0 },
          ],
        }),
      ],
      [{ id: "t1", title: "Task", instructions: "x" }],
      { runner: realRunner, workingDir: dir, roots: [dir], signal },
    );
    expect(out!.status).toBe("failed");
    expect(out!.error).toBe("syntax: 1 file failed (bad.js)");
    expect(out!.syntax!.checked).toBe(2);
    expect(out!.syntax!.output).toMatch(/^bad\.js: /);
    expect(out!.syntax!.output!.length).toBeLessThanOrEqual(SYNTAX_OUTPUT_CHARS);
    const rendered = formatDelegateOutput([out!], 8000);
    const [table, block] = rendered.split("\n\n");
    expect(table).toContain("- [t1] failed — Task — error: syntax: 1 file failed (bad.js)");
    // The verdict reads once on the table line.
    expect(table!.match(/syntax: 1 file failed/g)).toHaveLength(1);
    expect(block).toContain("syntax output:\nbad.js: ");
    expect(rendered).toContain("1 task: 1 failed");
  });

  it("falls back to the declared files, and leaves rows that are not green alone", async () => {
    const runner = vi.fn(realRunner);
    const rows = await runSyntaxPass(
      [row(), row({ id: "t2", status: "max_steps" })],
      [
        { id: "t1", title: "Task", instructions: "x", files: ["bad.js", "missing.js"] },
        { id: "t2", title: "Two", instructions: "x", files: ["bad.js"] },
      ],
      { runner, workingDir: dir, roots: [dir], signal },
    );
    expect(rows[0]!.status).toBe("failed");
    expect(rows[1]).toEqual(row({ id: "t2", status: "max_steps" }));
    // One run for the fan-out, only the files that exist.
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]![0]).toEqual([join(dir, "bad.js")]);
  });

  it("does not read outside the read scope, and counts files with no checker as unchecked", async () => {
    const outside = mkdtempSync(join(tmpdir(), "fusion-syntax-outside-"));
    try {
      mkdirSync(join(outside, "x"));
      writeFileSync(join(outside, "x", "o.js"), "const = ;\n");
      const runner = vi.fn(realRunner);
      const [out] = await runSyntaxPass(
        [
          row({
            changes: [
              { path: "notes.txt", kind: "new" },
              { path: join(outside, "x", "o.js"), kind: "new" },
            ],
          }),
        ],
        [{ id: "t1", title: "Task", instructions: "x" }],
        { runner, workingDir: dir, roots: [dir], signal },
      );
      expect(runner.mock.calls[0]![0]).toEqual([join(dir, "notes.txt")]);
      expect(out!.status).toBe("ok");
      expect(out!.syntax).toEqual({ checked: 0, failedFiles: [], unchecked: 1, outOfScope: 1 });
      expect(describeSyntax(out!.syntax!)).toBe(
        "syntax: 1 unchecked, 1 outside the read scope, not checked",
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("masks secrets in the checker's output", async () => {
    const runner: SyntaxCheckRunner = async (files) => ({
      results: files.map((file) => ({
        file,
        ok: false,
        checker: "fake",
        error: "Unexpected token near TOKEN=sk-live-0123456789abcdef",
      })),
    });
    const [out] = await runSyntaxPass(
      [row({ changes: [{ path: "good.js", kind: "new" }] })],
      [{ id: "t1", title: "Task", instructions: "x" }],
      {
        runner,
        workingDir: dir,
        roots: [dir],
        signal,
        knownSecrets: [{ label: "KEY", value: "sk-live-0123456789abcdef" }],
      },
    );
    expect(out!.syntax!.output).not.toContain("sk-live-0123456789abcdef");
  });

  it("a checker that throws claims no pass and demotes nothing", async () => {
    const [out] = await runSyntaxPass(
      [row({ changes: [{ path: "good.js", kind: "new" }] })],
      [{ id: "t1", title: "Task", instructions: "x" }],
      {
        runner: async () => {
          throw new Error("boom");
        },
        workingDir: dir,
        roots: [dir],
        signal,
      },
    );
    expect(out!.status).toBe("ok");
    expect(describeSyntax(out!.syntax!)).toBe("the syntax pass did not run: boom");
  });

  it("does nothing without a runner", async () => {
    const rows = [row({ changes: [{ path: "bad.js", kind: "new" }] })];
    expect(
      await runSyntaxPass(rows, [], { runner: undefined, workingDir: dir, roots: [dir], signal }),
    ).toEqual(rows);
  });
});
