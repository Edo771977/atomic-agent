import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { DEFAULT_FIXTURES_DIR, generateFixtures } from "./generate-fixtures.js";

describe("document fixture generation", () => {
  it("resolves its default destination as a native filesystem path", () => {
    expect(DEFAULT_FIXTURES_DIR).toBe(join(process.cwd(), "src", "tools", "os", "test-fixtures"));
  });

  it("writes usable binary and text fixtures only to an explicit disposable destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "atomic-fixtures-"));
    const output = join(root, "documents with spaces è");
    try {
      await generateFixtures(output);
      expect((await readdir(output)).sort()).toEqual([
        "sample.docx", "sample.md", "sample.odt", "sample.pdf", "sample.pptx", "sample.rtf",
        "sample.tar", "sample.tar.gz", "sample.txt", "sample.txt.gz", "sample.xlsx", "sample.zip",
      ]);
      expect((await readFile(join(output, "sample.pdf"))).subarray(0, 5).toString("ascii")).toBe("%PDF-");
      expect(await readFile(join(output, "sample.txt"), "utf8")).toBe("Plain text fixture.\nSecond line.\n");
      expect(gunzipSync(await readFile(join(output, "sample.txt.gz"))).toString("utf8")).toBe("single file gzip payload\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
