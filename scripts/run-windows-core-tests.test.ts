import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs script without declarations
import { coreDirectories, criticalFiles, deferredFiles, externalCriticalFiles, supplementalFiles, scopeDrift, supplementalDrift, quarantinedGateFiles } from "./run-windows-core-tests.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), "windows-core-scope-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("Windows core gate scope", () => {
  it("classifies every test file in its directories as critical or deferred", () => {
    expect(scopeDrift(root)).toEqual({ unclassified: [], missing: [], overlapping: [] });
  });

  it("keeps critical tests inside the scanned directories or explicit runtime seam list", () => {
    for (const path of criticalFiles as string[]) {
      expect((coreDirectories as string[]).some((dir) => path.startsWith(`${dir}/`)) || (externalCriticalFiles as string[]).includes(path), path).toBe(true);
    }
    for (const path of externalCriticalFiles as string[]) expect((criticalFiles as string[]).includes(path), path).toBe(true);
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

  it("validates the additional whole-file Windows regressions", () => {
    expect(supplementalFiles).toContain("src/tasks/task-store-open-failure.test.ts");
    expect(supplementalFiles).toContain("src/tools/os/shell/node-check-notice.test.ts");
    expect(supplementalDrift(root)).toEqual({ missing: [], duplicated: [], insideCore: [] });
    expect(supplementalDrift(root, ["src/missing.test.ts", "src/missing.test.ts", criticalFiles[0]])).toEqual({
      missing: ["src/missing.test.ts"],
      duplicated: ["src/missing.test.ts"],
      insideCore: [criticalFiles[0]],
    });
  });

  it("rejects quarantine of either a core or an additional regression", () => {
    expect(quarantinedGateFiles([
      { path: criticalFiles[0], status: "quarantined" },
      { path: supplementalFiles[0], status: "quarantined" },
      { path: supplementalFiles[1], status: "released" },
      { path: "src/unrelated.test.ts", status: "quarantined" },
    ])).toEqual([criticalFiles[0], supplementalFiles[0]]);
  });
});
