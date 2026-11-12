import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { osGitBlameTool } from "./git-blame.js";
import { osGitDiffTool } from "./git-diff.js";
import { osGitLogTool } from "./git-log.js";
import { osGitShowTool } from "./git-show.js";
import {
  makeCtx,
  makeGitRepo,
  runGitRaw,
  writeRepoFile,
} from "./test-helpers.js";

// A revision argument reaches git before `--`, where a leading dash makes
// it an option: `--no-index` turns diff's pathspecs into arbitrary files,
// `--contents=` feeds blame any file, `--output=` writes one.
describe("git read tools refuse revisions that are options", () => {
  let repo: string;
  let outside: string;
  beforeEach(async () => {
    repo = await makeGitRepo();
    outside = mkdtempSync(join(tmpdir(), "git-outside-"));
    writeFileSync(join(outside, "key"), "OUTSIDE-SECRET\n");
    await writeRepoFile(repo, "a", "tracked\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "seed"]);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("os.git.diff refuses --no-index as a revisionRange", async () => {
    await expect(
      osGitDiffTool.run(
        { revisionRange: "--no-index", paths: [join(outside, "key"), "a"] },
        makeCtx(repo),
      ),
    ).rejects.toThrow(/revisionRange.*must not start with "-"/);
  });

  it("os.git.diff refuses --output= as a revisionRange", async () => {
    const target = join(outside, "written");
    await expect(
      osGitDiffTool.run({ revisionRange: `--output=${target}` }, makeCtx(repo)),
    ).rejects.toThrow(/must not start with "-"/);
    expect(existsSync(target)).toBe(false);
  });

  it("os.git.blame refuses --contents= as a revision", async () => {
    await expect(
      osGitBlameTool.run(
        { revision: `--contents=${join(outside, "key")}`, path: "a" },
        makeCtx(repo),
      ),
    ).rejects.toThrow(/revision.*must not start with "-"/);
  });

  it("os.git.show and os.git.log refuse option-shaped revisions", async () => {
    const target = join(outside, "written");
    await expect(
      osGitShowTool.run({ revision: `--output=${target}` }, makeCtx(repo)),
    ).rejects.toThrow(/must not start with "-"/);
    await expect(
      osGitLogTool.run({ revisionRange: `--output=${target}` }, makeCtx(repo)),
    ).rejects.toThrow(/must not start with "-"/);
    expect(existsSync(target)).toBe(false);
  });

  it("still accepts ordinary revisions", async () => {
    const show = await osGitShowTool.run({ revision: "HEAD" }, makeCtx(repo));
    expect(show.status).toBe("ok");
    const log = await osGitLogTool.run({ revisionRange: "HEAD" }, makeCtx(repo));
    expect(log.status).toBe("ok");
    const blame = await osGitBlameTool.run(
      { revision: "HEAD", path: "a" },
      makeCtx(repo),
    );
    expect(blame.status).toBe("ok");
  });
});
