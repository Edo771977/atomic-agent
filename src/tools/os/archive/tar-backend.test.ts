import { describe, it, expect } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { pack } from "tar-stream";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TarBackend } from "./tar-backend.js";
import { DEFAULT_EXTRACT_LIMITS } from "./archive-types.js";

const TAR_FIXTURE = resolve(
  fileURLToPath(new URL("../test-fixtures/sample.tar", import.meta.url)),
);
const TGZ_FIXTURE = resolve(
  fileURLToPath(new URL("../test-fixtures/sample.tar.gz", import.meta.url)),
);

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "tar-backend-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("TarBackend", () => {
  it("lists entries from a plain .tar", async () => {
    const backend = new TarBackend("tar");
    const entries = await backend.list(readFileSync(TAR_FIXTURE));
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("hello.txt");
    expect(paths).toContain("nested/world.txt");
  });

  it("lists entries from a .tar.gz", async () => {
    const backend = new TarBackend("tar.gz");
    const entries = await backend.list(readFileSync(TGZ_FIXTURE));
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("hello.txt");
  });

  it("reads a single entry from tar", async () => {
    const backend = new TarBackend("tar");
    const body = await backend.readEntry(
      readFileSync(TAR_FIXTURE),
      "hello.txt",
    );
    expect(body.toString("utf8")).toBe("Hello from the archive.\n");
  });

  it("reads a single entry from tar.gz", async () => {
    const backend = new TarBackend("tar.gz");
    const body = await backend.readEntry(
      readFileSync(TGZ_FIXTURE),
      "nested/world.txt",
    );
    expect(body.toString("utf8")).toBe("Nested payload.\n");
  });

  it("extracts from a plain tar", async () => {
    const backend = new TarBackend("tar");
    await withTmp(async (dir) => {
      const report = await backend.extract(readFileSync(TAR_FIXTURE), {
        destDir: dir,
        overwrite: false,
        followSymlinks: false,
        limits: DEFAULT_EXTRACT_LIMITS,
      });
      expect(report.extractedEntries).toBeGreaterThanOrEqual(2);
      expect(await readFile(join(dir, "hello.txt"), "utf8")).toBe(
        "Hello from the archive.\n",
      );
    });
  });

  it("extracts from a tar.gz", async () => {
    const backend = new TarBackend("tar.gz");
    await withTmp(async (dir) => {
      const report = await backend.extract(readFileSync(TGZ_FIXTURE), {
        destDir: dir,
        overwrite: false,
        followSymlinks: false,
        limits: DEFAULT_EXTRACT_LIMITS,
      });
      expect(report.extractedEntries).toBeGreaterThanOrEqual(2);
      expect(await readFile(join(dir, "nested/world.txt"), "utf8")).toBe(
        "Nested payload.\n",
      );
    });
  });

  it("honours the maxEntries cap", async () => {
    const backend = new TarBackend("tar");
    await withTmp(async (dir) => {
      const report = await backend.extract(readFileSync(TAR_FIXTURE), {
        destDir: dir,
        overwrite: false,
        followSymlinks: false,
        limits: {
          maxTotalBytes: 1_000_000,
          maxEntryBytes: 1_000_000,
          maxEntries: 1,
        },
      });
      expect(
        report.skippedEntries.some((s) =>
          /max_entries_exceeded/.test(s.reason),
        ),
      ).toBe(true);
    });
  });
});

type TarSpec = {
  name: string;
  type?: "directory" | "symlink" | "link";
  linkname?: string;
  body?: string;
};

async function buildTar(entries: TarSpec[]): Promise<Buffer> {
  const p = pack();
  for (const e of entries) {
    if (e.type) p.entry({ name: e.name, type: e.type, linkname: e.linkname });
    else p.entry({ name: e.name }, e.body ?? "");
  }
  p.finalize();
  const chunks: Buffer[] = [];
  for await (const c of p) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function extractWithLinks(data: Buffer, destDir: string) {
  return new TarBackend("tar").extract(data, {
    destDir,
    overwrite: true,
    followSymlinks: true,
    limits: DEFAULT_EXTRACT_LIMITS,
  });
}

describe("TarBackend symlink containment", () => {
  it("does not write through a chain of symlinks the archive created", async () => {
    await withTmp(async (root) => {
      const dest = join(root, "ws", "out");
      const data = await buildTar([
        { name: "x/", type: "directory" },
        { name: "x/up", type: "symlink", linkname: ".." },
        { name: "x/up/e", type: "symlink", linkname: ".." },
        { name: "x/up/e/pwned.txt", body: "pwned" },
      ]);
      const report = await extractWithLinks(data, dest);
      expect(existsSync(join(root, "ws", "pwned.txt"))).toBe(false);
      expect(existsSync(join(dest, "pwned.txt"))).toBe(false);
      expect(
        report.skippedEntries.some((s) => s.path === "x/up/e/pwned.txt"),
      ).toBe(true);
    });
  });

  it("does not hard-link a file reached through an archive symlink", async () => {
    await withTmp(async (root) => {
      const dest = join(root, "out");
      writeFileSync(join(root, "secret.txt"), "secret");
      const data = await buildTar([
        { name: "a/", type: "directory" },
        { name: "a/up", type: "symlink", linkname: ".." },
        { name: "a/up/b", type: "symlink", linkname: ".." },
        { name: "copy.txt", type: "link", linkname: "a/up/b/secret.txt" },
      ]);
      await extractWithLinks(data, dest);
      expect(existsSync(join(dest, "copy.txt"))).toBe(false);
    });
  });

  it("does not write a file through a symlink at the entry path", async () => {
    await withTmp(async (root) => {
      const dest = join(root, "out");
      const data = await buildTar([
        { name: "target.txt", body: "inside" },
        { name: "link", type: "symlink", linkname: "target.txt" },
        { name: "link", body: "overwrite-through-link" },
      ]);
      const report = await extractWithLinks(data, dest);
      expect(await readFile(join(dest, "target.txt"), "utf8")).toBe("inside");
      expect(report.skippedEntries.some((s) => s.path === "link")).toBe(true);
    });
  });

  it("removes a symlink whose real target leaves destDir via another link", async () => {
    await withTmp(async (root) => {
      const dest = join(root, "out");
      const data = await buildTar([
        { name: "d/", type: "directory" },
        { name: "d/b", type: "symlink", linkname: ".." },
        { name: "a", type: "symlink", linkname: "d/b/.." },
      ]);
      const report = await extractWithLinks(data, dest);
      expect(existsSync(join(dest, "a"))).toBe(false);
      expect(report.skippedEntries.some((s) => s.path === "a")).toBe(true);
      expect(existsSync(join(dest, "d", "b"))).toBe(true);
    });
  });

  it("removes an escaping chained link even when extraction fails later", async () => {
    await withTmp(async (root) => {
      const dest = join(root, "out");
      const data = await buildTar([
        { name: "d/", type: "directory" },
        { name: "d/b", type: "symlink", linkname: ".." },
        { name: "a", type: "symlink", linkname: "d/b/.." },
        // A file over an existing directory: the write throws (EISDIR).
        { name: "z/", type: "directory" },
        { name: "z", body: "boom" },
      ]);
      await expect(extractWithLinks(data, dest)).rejects.toThrow();
      expect(() => lstatSync(join(dest, "a"))).toThrow();
      expect(existsSync(join(dest, "d", "b"))).toBe(true);
    });
  });

  it("keeps a symlink that stays inside destDir", async () => {
    await withTmp(async (root) => {
      const dest = join(root, "out");
      const data = await buildTar([
        { name: "real.txt", body: "ok" },
        { name: "alias", type: "symlink", linkname: "real.txt" },
      ]);
      await extractWithLinks(data, dest);
      expect(await readFile(join(dest, "alias"), "utf8")).toBe("ok");
    });
  });
});
