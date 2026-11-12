import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Record fsync (file or directory) and rename in order, delegating to
// the real implementation so the writes still happen on disk.
const calls = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      calls.push(actual.fstatSync(fd).isDirectory() ? "fsync:dir" : "fsync:file");
      return actual.fsyncSync(fd);
    },
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      calls.push("rename");
      return actual.renameSync(from, to);
    },
  };
});

const { writeOwnerOnlyFileAtomicSync } = await import("./owner-only-file.js");
const { setDotenvKey } = await import("./dotenv-writer.js");

describe("atomic writes flush before and after the rename", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-durable-write-"));
    calls.length = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.ATOMIC_DURABLE_TEST_KEY;
  });

  const expected =
    process.platform === "win32"
      ? ["fsync:file", "rename"]
      : ["fsync:file", "rename", "fsync:dir"];

  it("writeOwnerOnlyFileAtomicSync fsyncs the tmp file, renames, then fsyncs the directory", () => {
    const path = join(dir, "config.json");
    writeOwnerOnlyFileAtomicSync(path, '{"version":1}\n', () => {});
    expect(calls).toEqual(expected);
    expect(readFileSync(path, "utf8")).toBe('{"version":1}\n');
    if (process.platform !== "win32") {
      expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it("setDotenvKey fsyncs the tmp file, renames, then fsyncs the directory", () => {
    setDotenvKey(dir, "ATOMIC_DURABLE_TEST_KEY", "value");
    expect(calls).toEqual(expected);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(
      "ATOMIC_DURABLE_TEST_KEY=value\n",
    );
    if (process.platform !== "win32") {
      expect(fs.statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    }
  });
});
