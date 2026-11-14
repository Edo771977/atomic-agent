import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { freezeCheckInputs } from "./candidate-check-inputs.js";

const redirect = vi.hoisted(() => ({ target: "" }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const createReadStream = ((path: Parameters<typeof actual.createReadStream>[0], options?: Parameters<typeof actual.createReadStream>[1]) => {
    // A pathname reopened after lstat can resolve to a different transient target.
    const pinned = typeof options === "object" && options !== null && options.fd !== undefined;
    return actual.createReadStream(redirect.target && String(path).endsWith("check.mjs") && !pinned ? redirect.target : path, options);
  }) as typeof actual.createReadStream;
  return { ...actual, default: { ...actual, createReadStream }, createReadStream };
});
const roots: string[] = [];
afterEach(async () => { redirect.target = ""; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const signal = new AbortController().signal;

it("hashes the verified open file identity instead of reopening a mutable pathname", async () => {
  const root = await mkdtemp(join(tmpdir(), "atag-check-handle-")); roots.push(root);
  const original = join(root, "original"), candidate = join(root, "candidate"); await mkdir(original); await mkdir(candidate);
  await writeFile(join(original, "check.mjs"), "expected-good"); await writeFile(join(candidate, "check.mjs"), "weakened-evil");
  redirect.target = join(root, "outside.txt"); await writeFile(redirect.target, "same-transient-target");
  const frozen = await freezeCheckInputs(original, ["check.mjs"], signal);
  await expect(frozen.verify(candidate, signal)).rejects.toThrow(/check input changed/);
});

it("refuses outside, missing and oversized declared check files", async () => {
  const root = await mkdtemp(join(tmpdir(), "atag-check-bounds-")); roots.push(root);
  const project = join(root, "project"); await mkdir(project); await writeFile(join(root, "outside.mjs"), "test");
  await expect(freezeCheckInputs(project, [join(root, "outside.mjs")], signal)).rejects.toThrow(/inside/);
  await expect(freezeCheckInputs(project, ["missing.mjs"], signal)).rejects.toThrow();
  await writeFile(join(project, "large.mjs"), Buffer.alloc(2 * 1024 * 1024 + 1));
  await expect(freezeCheckInputs(project, ["large.mjs"], signal)).rejects.toThrow(/byte limit/);
});
it("refuses an excluded-directory input whose original ancestor is a link outside the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "atag-check-linked-")); roots.push(root);
  const project = join(root, "project"), outside = join(root, "outside"); await mkdir(project); await mkdir(outside);
  await writeFile(join(outside, "check.mjs"), "outside unchanged");
  await symlink(outside, join(project, "dist"), process.platform === "win32" ? "junction" : "dir");
  await expect(freezeCheckInputs(project, ["dist/check.mjs"], signal)).rejects.toThrow(/linked ancestor/);
  expect(await readFile(join(outside, "check.mjs"), "utf8")).toBe("outside unchanged");
});
