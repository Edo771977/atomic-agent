import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

const realRunner: SyntaxCheckRunner = (files, dir, options) => verifySyntax(files, dir, options);

/** This repository's own tsc, resolved through the `.bin` symlink. */
const REAL_TSC = realpathSync(resolve(process.cwd(), "node_modules/.bin/tsc"));

/** A strict TypeScript project in `dir` with its own `node_modules/.bin/tsc`. */
function tsProject(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: "ES2022", types: [] },
      include: ["src/**/*.ts"],
    }),
  );
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  symlinkSync(REAL_TSC, join(dir, "node_modules", ".bin", "tsc"));
}

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

  it("checks the declared files as well as the changed ones (a shell may have written them)", async () => {
    const runner = vi.fn(realRunner);
    const [out] = await runSyntaxPass(
      [row({ shellRan: true, changes: [{ path: "good.js", kind: "modified", addedLines: 1, removedLines: 0 }] })],
      [{ id: "t1", title: "Task", instructions: "x", files: ["good.js", "bad.js", "missing.js"] }],
      { runner, workingDir: dir, roots: [dir], signal },
    );
    expect(runner.mock.calls[0]![0]).toEqual([join(dir, "good.js"), join(dir, "bad.js")]);
    expect(out!.status).toBe("failed");
    expect(out!.syntax).toMatchObject({ checked: 2, failedFiles: ["bad.js"] });
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

  it("notes a type error in a TypeScript file without demoting the row; a parse error demotes", async () => {
    // Two projects: tsc withholds every semantic diagnostic in a program
    // once any of its files has a parse error.
    tsProject(join(dir, "a"));
    tsProject(join(dir, "b"));
    // A missing module and a pre-existing type error: not the worker's syntax.
    writeFileSync(
      join(dir, "a", "src", "typed.ts"),
      'import { x } from "not-installed";\nexport const n: number = "no";\nexport const y = x;\n',
    );
    writeFileSync(join(dir, "b", "src", "broken.ts"), "export const c = ;\n");
    const rows = await runSyntaxPass(
      [
        row({ changes: [{ path: "a/src/typed.ts", kind: "modified", addedLines: 1, removedLines: 0 }] }),
        row({ id: "t2", changes: [{ path: "b/src/broken.ts", kind: "new", addedLines: 1, removedLines: 0 }] }),
      ],
      [
        { id: "t1", title: "Task", instructions: "x" },
        { id: "t2", title: "Two", instructions: "x" },
      ],
      { runner: realRunner, workingDir: dir, roots: [dir], signal },
    );
    expect(rows[0]!.status).toBe("ok");
    expect(rows[0]!.syntax).toMatchObject({ checked: 1, failedFiles: [], typeErrors: 2 });
    expect(rows[0]!.syntax!.typeOutput).toMatch(/^a\/src\/typed\.ts: line 1: error TS2\d{3}: Cannot find module/);
    expect(rows[1]!.status).toBe("failed");
    expect(rows[1]!.error).toBe("syntax: 1 file failed (b/src/broken.ts)");
    expect(rows[1]!.syntax!.output).toMatch(/TS1109/);
    const rendered = formatDelegateOutput(rows, 8000);
    const table = rendered.split("\n\n")[0]!;
    expect(table).toContain("- [t1] ok — Task — syntax ok (1 file); types: 2 errors (not demoted)");
    expect(rendered).toContain("type errors:\na/src/typed.ts: line 1: error TS2");
  }, 60_000);

  it("gives up at its budget without demoting, and aborts the runner's signal", async () => {
    let seen: AbortSignal | undefined;
    const runner: SyntaxCheckRunner = (_files, _dir, options) => {
      seen = options.signal;
      return new Promise(() => {}); // a checker that never answers
    };
    const started = Date.now();
    const [out] = await runSyntaxPass(
      [row({ changes: [{ path: "bad.js", kind: "new" }] })],
      [{ id: "t1", title: "Task", instructions: "x" }],
      { runner, workingDir: dir, roots: [dir], signal, budgetMs: 50 },
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(out!.status).toBe("ok");
    expect(out!.syntax).toMatchObject({ checked: 0, unchecked: 1 });
    expect(describeSyntax(out!.syntax!)).toBe(
      "syntax: not checked, the pass ran out of its 50 ms budget",
    );
    expect(seen?.aborted).toBe(true);
  });

  it("returns at once when the delegate is cancelled mid-pass, claiming nothing", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const runner: SyntaxCheckRunner = (_files, _dir, options) => {
      seen = options.signal;
      setTimeout(() => controller.abort(), 20);
      return new Promise(() => {});
    };
    const rows = [row({ changes: [{ path: "bad.js", kind: "new" }] })];
    const out = await runSyntaxPass(rows, [{ id: "t1", title: "Task", instructions: "x" }], {
      runner,
      workingDir: dir,
      roots: [dir],
      signal: controller.signal,
    });
    expect(out).toEqual(rows);
    expect(seen?.aborted).toBe(true);
  });

  it("does nothing without a runner", async () => {
    const rows = [row({ changes: [{ path: "bad.js", kind: "new" }] })];
    expect(
      await runSyntaxPass(rows, [], { runner: undefined, workingDir: dir, roots: [dir], signal }),
    ).toEqual(rows);
  });
});
