import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createBranchSet } from "./branch-workspace.js";
import { createCandidateIntegration } from "./candidate-integration.js";

const links = vi.hoisted(() => ({ refuse: true, calls: 0, after: 0, junction: false, code: "EPERM" }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const symlink = (async (...args: Parameters<typeof actual.symlink>) => {
    links.calls += 1;
    if (links.refuse && links.calls > links.after) throw Object.assign(new Error("directory link privilege unavailable"), { code: links.code });
    if (links.junction && args[2] === "dir") return actual.symlink(args[0], args[1], "junction");
    return actual.symlink(...args);
  }) as typeof actual.symlink;
  return { ...actual, symlink, default: { ...actual, symlink } };
});
const roots: string[] = [];
afterEach(async () => {
  links.refuse = true; links.calls = 0; links.after = 0; links.junction = false; links.code = "EPERM";
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function project() {
  const root = await mkdtemp(join(tmpdir(), "atag-link-fallback-")); roots.push(root);
  await mkdir(join(root, "node_modules", "dep"), { recursive: true });
  await writeFile(join(root, "node_modules", "dep", "index.js"), "original dependency\n");
  await writeFile(join(root, "input.txt"), "original input\n");
  return root;
}

it("privately copies generated dependency directories when directory links are denied", async () => {
  const root = await project();
  const set = await createBranchSet(root, ["one", "two"], { git: async () => null });
  expect(set).not.toBeNull();
  try {
    const one = set!.workspaces.get("one")!.dir; const two = set!.workspaces.get("two")!.dir;
    expect((await lstat(join(one, "node_modules"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(two, "node_modules", "dep", "index.js"), "utf8")).toBe("original dependency\n");
    await writeFile(join(one, "node_modules", "dep", "index.js"), "private rebuild\n");
    expect(await readFile(join(root, "node_modules", "dep", "index.js"), "utf8")).toBe("original dependency\n");
    expect(await readFile(join(two, "node_modules", "dep", "index.js"), "utf8")).toBe("original dependency\n");
    expect([...set!.workspaces.get("one")!.manifest.keys()]).toEqual(["input.txt"]);
  } finally { await set?.cleanup(); }
});

it("refuses isolation when fallback copies exceed the shared byte budget", async () => {
  const root = await project();
  const set = await createBranchSet(root, ["one"], { git: async () => null, maxCopyBytes: 35 });
  expect(set).toBeNull();
  expect(await readFile(join(root, "input.txt"), "utf8")).toBe("original input\n");
  expect(await readFile(join(root, "node_modules", "dep", "index.js"), "utf8")).toBe("original dependency\n");
});

it("preserves unexpected link errors rather than treating them as unavailable privileges", async () => {
  links.code = "EIO";
  const root = await project();
  await expect(createBranchSet(root, ["one"], { git: async () => null })).rejects.toThrow("directory link privilege unavailable");
  expect(await readFile(join(root, "node_modules", "dep", "index.js"), "utf8")).toBe("original dependency\n");
});

it("privately copies a generated base link when recreating it for a task is denied", async () => {
  links.after = 1; links.junction = process.platform === "win32";
  const root = await project(); const set = await createBranchSet(root, ["one"], { git: async () => null });
  expect(set).not.toBeNull();
  try {
    expect((await lstat(join(set!.baseDir, "node_modules"))).isSymbolicLink()).toBe(true);
    const dir = set!.workspaces.get("one")!.dir;
    expect((await lstat(join(dir, "node_modules"))).isSymbolicLink()).toBe(false);
    await writeFile(join(dir, "node_modules", "dep", "index.js"), "private task rebuild\n");
    expect(await readFile(join(root, "node_modules", "dep", "index.js"), "utf8")).toBe("original dependency\n");
  } finally { await set?.cleanup(); }
});

it("keeps a candidate's dependency bytes private after a link fallback", async () => {
  const root = await project(); const candidate = await createCandidateIntegration(root, { git: async () => null });
  try {
    expect((await lstat(join(candidate.dir, "node_modules"))).isSymbolicLink()).toBe(false);
    await writeFile(join(candidate.dir, "node_modules", "dep", "index.js"), "private candidate rebuild\n");
    expect((await candidate.reject("test" )).status).toBe("rejected");
    expect(await readFile(join(root, "node_modules", "dep", "index.js"), "utf8")).toBe("original dependency\n");
  } finally { await candidate.cleanup(); }
});

it("creates a native candidate with dependency directories without directory-link privileges", async () => {
  links.refuse = false;
  const root = await project(); const candidate = await createCandidateIntegration(root, { git: async () => null });
  try {
    expect((await lstat(join(candidate.dir, "node_modules"))).isSymbolicLink()).toBe(false);
    await writeFile(join(candidate.dir, "node_modules", "dep", "index.js"), "private native rebuild\n");
    expect(await readFile(join(root, "node_modules", "dep", "index.js"), "utf8")).toBe("original dependency\n");
  } finally { await candidate.cleanup(); }
});

it("does not follow a user-created directory link outside the project on failure", async () => {
  const root = await project(); const outside = await mkdtemp(join(tmpdir(), "atag-user-link-")); roots.push(outside);
  await writeFile(join(outside, "protected.txt"), "outside bytes\n");
  links.refuse = false;
  // A junction is a user link too; native Windows can create it without the
  // directory-symlink privilege. The runtime must never expand its target.
  await symlink(outside, join(root, "user-link"), process.platform === "win32" ? "junction" : "dir");
  links.refuse = true; links.calls = 0;
  await expect(createBranchSet(root, ["one"], { git: async () => null })).rejects.toThrow("directory link privilege unavailable");
  expect(await readFile(join(outside, "protected.txt"), "utf8")).toBe("outside bytes\n");
});
