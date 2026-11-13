import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Record fsync (file or directory) and rename in order, delegating to
// the real implementation so the writes still happen on disk.
const calls = vi.hoisted(() => [] as string[]);
// Errno codes the next calls throw, consumed one per call.
const faults = vi.hoisted(() => ({
  rename: [] as string[],
  fsyncFile: [] as string[],
  write: [] as string[],
}));
function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code });
}
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      const isDir = actual.fstatSync(fd).isDirectory();
      calls.push(isDir ? "fsync:dir" : "fsync:file");
      const code = isDir ? undefined : faults.fsyncFile.shift();
      if (code) throw errno(code);
      return actual.fsyncSync(fd);
    },
    writeSync: ((...args: Parameters<typeof actual.writeSync>) => {
      const code = faults.write.shift();
      if (code) throw errno(code);
      return (actual.writeSync as (...a: unknown[]) => number)(...args);
    }) as typeof actual.writeSync,
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

describe("a failed tmp write never leaves the tmp file (it can hold secrets)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-durable-fail-"));
    calls.length = 0;
    faults.fsyncFile = [];
    faults.write = [];
    faults.rename = [];
  });

  afterEach(() => {
    faults.fsyncFile = [];
    faults.write = [];
    faults.rename = [];
    rmSync(dir, { recursive: true, force: true });
    delete process.env.ATOMIC_DURABLE_TEST_KEY;
  });

  it.each(["EIO", "ENOSPC"])("setDotenvKey: a file fsync %s fails the write and removes .env.tmp-<pid>", (code) => {
    faults.fsyncFile = [code];
    expect(() => setDotenvKey(dir, "ATOMIC_DURABLE_TEST_KEY", "secret")).toThrow(code);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(calls).not.toContain("rename");
  });

  it("writeOwnerOnlyFileAtomicSync: a file fsync EIO keeps the old file and removes the tmp", () => {
    const path = join(dir, "config.json");
    fs.writeFileSync(path, "old\n");
    faults.fsyncFile = ["EIO"];
    expect(() => writeOwnerOnlyFileAtomicSync(path, "new\n", () => {})).toThrow("EIO");
    expect(fs.readdirSync(dir)).toEqual(["config.json"]);
    expect(readFileSync(path, "utf8")).toBe("old\n");
  });

  it("a write error removes the tmp file too", () => {
    faults.write = ["ENOSPC"];
    expect(() => setDotenvKey(dir, "ATOMIC_DURABLE_TEST_KEY", "secret")).toThrow("ENOSPC");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("a rename error removes the tmp file", () => {
    const path = join(dir, "config.json");
    faults.rename = ["EXDEV"];
    expect(() => writeOwnerOnlyFileAtomicSync(path, "new\n", () => {})).toThrow("EXDEV");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it.each(["EINVAL", "ENOTSUP", "EOPNOTSUPP"])("a file fsync %s (not supported) is best effort: the write goes ahead", (code) => {
    faults.fsyncFile = [code];
    setDotenvKey(dir, "ATOMIC_DURABLE_TEST_KEY", "value");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("ATOMIC_DURABLE_TEST_KEY=value\n");
    expect(fs.readdirSync(dir)).toEqual([".env"]);
  });
});
