import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs script without declarations
import { coreDirectories, criticalFiles, deferredFiles, scopeDrift } from "./run-windows-core-tests.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), "windows-core-scope-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("Windows core gate scope", () => {
  it("classifies every test file in its directories as critical or deferred", () => {
    expect(scopeDrift(root)).toEqual({ unclassified: [], missing: [], overlapping: [] });
  });

  it("keeps the critical list inside the scanned directories", () => {
    for (const path of criticalFiles as string[]) {
      expect((coreDirectories as string[]).some((dir) => path.startsWith(`${dir}/`)), path).toBe(true);
    }
    expect((deferredFiles as string[]).length).toBeGreaterThan(0);
  });

  it("reports a new unlisted test file and a stale listed one", () => {
    const fake = join(scratch, "drift");
    for (const path of [...(criticalFiles as string[]).slice(1), ...(deferredFiles as string[]), "src/tools/fusion/brand-new.test.ts"]) {
      mkdirSync(dirname(join(fake, path)), { recursive: true });
      writeFileSync(join(fake, path), "");
    }
    expect(scopeDrift(fake)).toEqual({
      unclassified: ["src/tools/fusion/brand-new.test.ts"],
      missing: [(criticalFiles as string[])[0]],
      overlapping: [],
    });
  });
});
