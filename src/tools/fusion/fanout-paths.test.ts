import { homedir } from "node:os";
import { dirname, join, parse, toNamespacedPath } from "node:path";
import { describe, expect, it } from "vitest";

import { collapseScope, resolveFanoutScope } from "./fanout-paths.js";
import type { DelegateTask } from "./delegate-args.js";

function task(patch: Partial<DelegateTask> = {}): DelegateTask {
  return {
    id: "t1",
    title: "Write a module",
    instructions: "Do the thing.",
    ...patch,
  };
}

const CWD = join(process.cwd(), "review-project");
const OUTPUT = join(process.cwd(), "review-output");

describe("resolveFanoutScope", () => {
  it("takes the directories a brief names in `files`", () => {
    const scope = resolveFanoutScope(
      [task({ files: [join(OUTPUT, "cart.js"), join(OUTPUT, "cart.test.js")] })],
      CWD,
    );
    expect(scope).toContain(OUTPUT);
  });

  it("reads paths out of the prose when `files` is empty", () => {
    // The session that exposed all of this: the orchestrator wrote every
    // path into the instructions and left `files` unset. Refusing to
    // read that would mean no scope and no fix.
    const scope = resolveFanoutScope(
      [
        task({
          instructions:
            `Create directory ${OUTPUT} if needed. Write two files:\n` +
            `1. ${join(OUTPUT, "cart.js")} — export function addItem(cart, item).\n` +
            `2. ${join(OUTPUT, "cart.test.js")} — use node:test.`,
        }),
      ],
      CWD,
    );
    expect(scope).toContain(OUTPUT);
  });

  it("does not mistake prose for paths", () => {
    // A loose pattern over a model's writing finds version numbers and
    // sentence fragments, and every false positive widens what the
    // operator is about to authorise.
    const scope = resolveFanoutScope(
      [
        task({
          instructions:
            "Use node:test. Target v1.2.3 of the spec. Cover e.g. the empty case.",
        }),
      ],
      CWD,
    );
    expect(scope).toEqual([CWD]);
  });

  it("reads native absolute paths from prose without treating versions or drive-relative words as paths", () => {
    const cwd = join(process.cwd(), "review-project");
    const outside = join(process.cwd(), "review-output");
    const path = join(outside, "result.ts");
    const scope = resolveFanoutScope([task({ instructions: `Write ${path}; then review.` })], cwd);
    expect(scope).toContain(outside);
    expect(resolveFanoutScope([task({ instructions: "Use v1.2.3, https://example.org/file.ts and C:notes.ts." })], cwd)).toEqual([cwd]);
    if (process.platform === "win32") {
      expect(resolveFanoutScope([task({ instructions: "Write C:/review-output/result.ts" })], cwd)).toContain("C:/review-output");
      expect(resolveFanoutScope([task({ deliverable: "Save \\\\server\\share\\output\\result.ts" })], cwd)).toContain("\\\\server\\share\\output");
      // File names at the drive/share root must never widen a fan-out to it.
      expect(resolveFanoutScope([task({ instructions: "Write C:\\result.ts and \\\\server\\share\\result.ts" })], cwd)).toEqual([cwd]);
    }
  });

  it("always includes the working directory as the floor", () => {
    expect(resolveFanoutScope([task()], CWD)).toEqual([CWD]);
  });

  it("resolves a relative path against the working directory", () => {
    const scope = resolveFanoutScope([task({ files: ["./src/a.ts"] })], CWD);
    expect(scope).toEqual([CWD]);
  });
});

describe("collapseScope", () => {
  it("keeps the shallowest directory that covers the others", () => {
    expect(collapseScope(["/tmp/x/sub", "/tmp/x", "/tmp/x/sub/deeper"])).toEqual(
      ["/tmp/x"],
    );
  });

  it("keeps genuinely separate roots apart", () => {
    expect(collapseScope(["/tmp/a", "/tmp/b"]).sort()).toEqual([
      "/tmp/a",
      "/tmp/b",
    ]);
  });

  it("does not treat a sibling with a shared prefix as contained", () => {
    // `/tmp/rel-2-backup` is not inside `/tmp/rel-2`, however the
    // strings compare.
    expect(collapseScope(["/tmp/rel-2", "/tmp/rel-2-backup"]).sort()).toEqual([
      "/tmp/rel-2",
      "/tmp/rel-2-backup",
    ]);
  });

  it("refuses roots too broad to hand to a fan-out", () => {
    // One prompt authorises several workers to write unattended. `/` and
    // the home directory are not scopes, they are the absence of one.
    expect(collapseScope(["/"])).toEqual([]);
    expect(collapseScope([homedir()])).toEqual([]);
  });

  it("refuses native root and home aliases without rejecting their siblings", () => {
    const home = homedir();
    expect(collapseScope([parse(home).root, join(home, ".."), join(home, ".")])).toEqual([]);
    const sibling = `${dirname(home)}-review`;
    expect(collapseScope([sibling])).toEqual([sibling]);
    if (process.platform === "win32") {
      expect(collapseScope(["C:\\", "c:/", "C:\\folder\\..", "\\\\server\\share\\", "//server/share/"])).toEqual([]);
      expect(collapseScope([home.toUpperCase().replaceAll("\\", "/")])).toEqual([]);
    }
  });

  it("refuses namespaced broad roots and unsupported device scope spellings", () => {
    expect(collapseScope([toNamespacedPath(homedir()), toNamespacedPath(dirname(homedir()))])).toEqual([]);
    if (process.platform === "win32") {
      for (const path of [
        "\\\\?\\C:\\", "\\\\?\\UNC\\server\\share\\", "\\\\?\\unc\\SERVER\\SHARE\\",
        "\\\\.\\C:\\project", "//?/C:/project", "//./C:/project", "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\project",
        "\\\\?\\C:\\project\\.\\src", "\\\\?\\C:\\project\\..\\src", "\\\\?\\C:\\project.\\src", "\\\\?\\C:\\project \\src",
        "\\\\?\\C:\\project\\NUL", "\\\\?\\UNC\\server\\share.\\project",
        `${homedir()}.`, `${homedir()} `,
      ]) expect(collapseScope([path]), path).toEqual([]);
      expect(collapseScope([toNamespacedPath(join(homedir(), "review-safe"))])).toEqual([join(homedir(), "review-safe")]);
    }
  });
});
