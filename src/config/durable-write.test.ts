import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Record fsync (file or directory) and rename in order, delegating to
// the real implementation so the writes still happen on disk.
const calls = vi.hoisted(() => [] as string[]);
// Errno codes the next calls throw, consumed one per call.
const faults = vi.hoisted(() => ({ rename: [] as string[] }));
function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code });
}
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
      const code = faults.rename.shift();
      if (code) throw errno(code);
      return actual.renameSync(from, to);
    },
  };
});

const { writeOwnerOnlyFileAtomicSync } = await import("./owner-only-file.js");
const { setDotenvKey } = await import("./dotenv-writer.js");
const { renameWithRetrySync } = await import("./durable-write.js");

describe("renameWithRetrySync", () => {
  let dir: string;
  let from: string;
  let to: string;
  let sleeps: number[];
  const sleep = (ms: number): void => {
    sleeps.push(ms);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-rename-retry-"));
    from = join(dir, "a.tmp");
    to = join(dir, "a");
    fs.writeFileSync(from, "new");
    fs.writeFileSync(to, "old");
    calls.length = 0;
    sleeps = [];
    faults.rename = [];
  });

  afterEach(() => {
    faults.rename = [];
    rmSync(dir, { recursive: true, force: true });
  });

  it("on win32 rides out a transient EBUSY/EPERM/EACCES with short backoffs", () => {
    faults.rename = ["EBUSY", "EPERM", "EACCES"];
    renameWithRetrySync(from, to, { platform: "win32", sleep });
    expect(calls).toEqual(["rename", "rename", "rename", "rename"]);
    expect(sleeps).toEqual([10, 30, 60]);
    expect(readFileSync(to, "utf8")).toBe("new");
  });

  it("gives up after five attempts and under 200ms of backoff, throwing the last error", () => {
    faults.rename = ["EBUSY", "EBUSY", "EBUSY", "EBUSY", "EPERM", "EBUSY"];
    expect(() => renameWithRetrySync(from, to, { platform: "win32", sleep })).toThrow(/EPERM/);
    expect(calls).toHaveLength(5);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(200);
    expect(readFileSync(to, "utf8")).toBe("old");
  });

  it("does not retry other codes, or any code off Windows", () => {
    faults.rename = ["ENOENT"];
    expect(() => renameWithRetrySync(from, to, { platform: "win32", sleep })).toThrow(/ENOENT/);
    faults.rename = ["EBUSY"];
    expect(() => renameWithRetrySync(from, to, { platform: "linux", sleep })).toThrow(/EBUSY/);
    expect(calls).toEqual(["rename", "rename"]);
    expect(sleeps).toEqual([]);
  });
});

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
