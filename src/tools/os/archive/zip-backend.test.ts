import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { ZipBackend } from "./zip-backend.js";
import { DEFAULT_EXTRACT_LIMITS } from "./archive-types.js";

const FIXTURE = resolve(
  fileURLToPath(new URL("../test-fixtures/sample.zip", import.meta.url)),
);

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "zip-backend-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("ZipBackend", () => {
  it("lists every entry with path + kind + size", async () => {
    const backend = new ZipBackend();
    const entries = await backend.list(readFileSync(FIXTURE));
    const byPath = new Map(entries.map((e) => [e.path, e]));
    expect(byPath.get("hello.txt")?.kind).toBe("file");
    expect(byPath.get("nested/world.txt")?.kind).toBe("file");
    expect(byPath.get("empty")?.kind).toBe("directory");
  });

  it("reads a single entry as a Buffer", async () => {
    const backend = new ZipBackend();
    const body = await backend.readEntry(readFileSync(FIXTURE), "hello.txt");
    expect(body.toString("utf8")).toBe("Hello from the archive.\n");
  });

  it("throws when the entry is missing", async () => {
    const backend = new ZipBackend();
    await expect(
      backend.readEntry(readFileSync(FIXTURE), "nope.txt"),
    ).rejects.toThrow(/entry not found/);
  });

  it("extracts files + directories into destDir", async () => {
    const backend = new ZipBackend();
    await withTmp(async (dir) => {
      const report = await backend.extract(readFileSync(FIXTURE), {
        destDir: dir,
        overwrite: false,
        followSymlinks: false,
        limits: DEFAULT_EXTRACT_LIMITS,
      });
      expect(report.extractedEntries).toBeGreaterThanOrEqual(2);
      const helloBody = await readFile(join(dir, "hello.txt"), "utf8");
      expect(helloBody).toBe("Hello from the archive.\n");
      const nested = await readFile(join(dir, "nested/world.txt"), "utf8");
      expect(nested).toBe("Nested payload.\n");
    });
  });

  it("refuses to extract zip-slip entries", async () => {
    const zip = new JSZip();
    zip.file("../escape.txt", "mwahaha");
    zip.file("safe.txt", "ok");
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const backend = new ZipBackend();
    await withTmp(async (dir) => {
      const report = await backend.extract(buf, {
        destDir: dir,
        overwrite: false,
        followSymlinks: false,
        limits: DEFAULT_EXTRACT_LIMITS,
      });
      const reasons = report.skippedEntries.map((s) => s.reason).join("\n");
      // JSZip normalises "../x" into "/x" internally, so the sanitizer
      // rejects it as absolute-path rather than traversal. Either reason
      // counts as a successful zip-slip defence.
      expect(reasons).toMatch(/escape the destination|absolute paths/);
      // The only entry we keep is the safe one; the traversal attempt never
      // hits the filesystem as a real file.
      const fsFiles = await readFile(join(dir, "safe.txt"), "utf8").catch(
        () => null,
      );
      expect(fsFiles).toBe("ok");
    });
  });

  it("refuses to overwrite unless overwrite=true", async () => {
    const backend = new ZipBackend();
    await withTmp(async (dir) => {
      await backend.extract(readFileSync(FIXTURE), {
        destDir: dir,
        overwrite: false,
        followSymlinks: false,
        limits: DEFAULT_EXTRACT_LIMITS,
      });
      const second = await backend.extract(readFileSync(FIXTURE), {
        destDir: dir,
        overwrite: false,
        followSymlinks: false,
        limits: DEFAULT_EXTRACT_LIMITS,
      });
      expect(
        second.skippedEntries.some((s) => /overwrite=false/.test(s.reason)),
      ).toBe(true);
    });
  });

  it("honours the include prefix filter", async () => {
    const backend = new ZipBackend();
    await withTmp(async (dir) => {
      const report = await backend.extract(readFileSync(FIXTURE), {
        destDir: dir,
        overwrite: false,
        followSymlinks: false,
        limits: DEFAULT_EXTRACT_LIMITS,
        include: ["nested"],
      });
      expect(report.extractedEntries).toBe(1);
    });
  });

  it("respects maxEntryBytes cap", async () => {
    const backend = new ZipBackend();
    await withTmp(async (dir) => {
      const report = await backend.extract(readFileSync(FIXTURE), {
        destDir: dir,
        overwrite: false,
        followSymlinks: false,
        limits: { maxTotalBytes: 1_000, maxEntryBytes: 5, maxEntries: 100 },
      });
      expect(
        report.skippedEntries.some((s) =>
          /entry_exceeds_max_entry_bytes/.test(s.reason),
        ),
      ).toBe(true);
    });
  });
});

describe("ZipBackend symlink containment", () => {
  const LINK = { unixPermissions: 0o120777 };

  it("does not write through a chain of symlinks the archive created", async () => {
    const zip = new JSZip();
    zip.folder("x");
    zip.file("x/up", "..", LINK);
    zip.file("x/up/e", "..", LINK);
    zip.file("x/up/e/pwned.txt", "pwned");
    const buf = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
    await withTmp(async (root) => {
      const dest = join(root, "ws", "out");
      const report = await new ZipBackend().extract(buf, {
        destDir: dest,
        overwrite: true,
        followSymlinks: true,
        limits: DEFAULT_EXTRACT_LIMITS,
      });
      expect(existsSync(join(root, "ws", "pwned.txt"))).toBe(false);
      expect(existsSync(join(dest, "pwned.txt"))).toBe(false);
      expect(
        report.skippedEntries.some((s) => s.path === "x/up/e/pwned.txt"),
      ).toBe(true);
    });
  });

  it("keeps a symlink that stays inside destDir", async () => {
    const zip = new JSZip();
    zip.file("real.txt", "ok");
    zip.file("alias", "real.txt", LINK);
    const buf = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
    await withTmp(async (dest) => {
      await new ZipBackend().extract(buf, {
        destDir: dest,
        overwrite: true,
        followSymlinks: true,
        limits: DEFAULT_EXTRACT_LIMITS,
      });
      expect(await readFile(join(dest, "alias"), "utf8")).toBe("ok");
    });
  });
});
