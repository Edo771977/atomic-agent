import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fusionCommand } from "./fusion-command.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const candidate = "candidate-012345abcdef";
async function fixture(status: "intent" | "applied" = "applied") {
  const project = await mkdtemp(join(tmpdir(), "atag-recovery-cli-")); roots.push(project);
  const merge = join(project, ".atomic-agent", "fusion-merge"), backup = `${candidate}.promotion-backup/0`;
  await mkdir(join(merge, `${candidate}.promotion-backup`), { recursive: true });
  await writeFile(join(project, "output.txt"), "promoted\n");
  const mode = (await lstat(join(project, "output.txt"))).mode & 0o777;
  await writeFile(join(merge, backup), "original\n");
  const journal = join(merge, `${candidate}.promotion.json`);
  const value = { version: 2, candidate, project, startedAt: new Date().toISOString(), ownerPid: 2147483647, state: "promoting", steps: [
    { path: "output.txt", action: "write", status, original: { kind: "file", mode, sha256: hash("original\n") }, promoted: { kind: "file", mode, sha256: hash("promoted\n") }, backup },
  ] };
  await writeFile(journal, JSON.stringify(value));
  return { project, journal, merge, value };
}
async function run(project: string, journal: string, args: string[] = []) {
  let stdout = "", stderr = "";
  const code = await fusionCommand(["recover", journal, "--project", project, "--json", ...args], {
    stdout: text => { stdout += text; }, stderr: text => { stderr += text; },
  });
  return { code, stdout, stderr };
}

it("defaults to read-only recovery status and makes dry-run read-only too", async () => {
  const f = await fixture(); const before = await readFile(f.journal), names = await readdir(f.merge);
  for (const args of [[], ["--status"], ["--dry-run"]]) {
    const result = await run(f.project, f.journal, args);
    expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout).state).toBe("promoting");
    expect(await readFile(join(f.project, "output.txt"), "utf8")).toBe("promoted\n");
    expect(await readFile(f.journal)).toEqual(before); expect(await readdir(f.merge)).toEqual(names);
  }
});

it.each(["intent", "applied"] as const)("explicitly rolls back a crash at %s and can be repeated safely", async status => {
  const f = await fixture(status);
  const first = await run(f.project, f.journal, ["--rollback"]);
  expect(first.code, first.stderr).toBe(0);
  expect(await readFile(join(f.project, "output.txt"), "utf8")).toBe("original\n");
  const second = await run(f.project, f.journal, ["--rollback"]);
  expect(second.code, second.stderr).toBe(0);
  expect(await readFile(join(f.project, "output.txt"), "utf8")).toBe("original\n");
});

it("treats original bytes after an interrupted rollback as already restored", async () => {
  const f = await fixture(); f.value.state = "rolling-back";
  await writeFile(join(f.project, "output.txt"), "original\n"); await writeFile(f.journal, JSON.stringify(f.value));
  const result = await run(f.project, f.journal, ["--rollback"]);
  expect(result.code, result.stderr).toBe(0); expect(await readFile(join(f.project, "output.txt"), "utf8")).toBe("original\n");
});

it("preserves a later user edit as a conflict across repeated recovery", async () => {
  const f = await fixture(); await writeFile(join(f.project, "output.txt"), "user edit\n");
  for (let i = 0; i < 2; i++) {
    const result = await run(f.project, f.journal, ["--rollback"]);
    expect(result.code).toBe(1); expect(result.stdout + result.stderr).toContain("output.txt");
    expect(await readFile(join(f.project, "output.txt"), "utf8")).toBe("user edit\n");
    expect(await readFile(join(f.merge, f.value.steps[0]!.backup), "utf8")).toBe("original\n");
  }
});

it.each(["committed", "live-owner", "corrupt-backup", "unknown-version", "outside-project", "traversal", "old-symlink"])("refuses unsafe rollback: %s", async kind => {
  const f = await fixture();
  const value = f.value as unknown as Record<string, unknown>;
  if (kind === "committed") value.state = "committed";
  if (kind === "live-owner") value.ownerPid = process.pid;
  if (kind === "corrupt-backup") await writeFile(join(f.merge, f.value.steps[0]!.backup), "corrupted");
  if (kind === "unknown-version") value.version = 991;
  if (kind === "outside-project") value.project = join(f.project, "elsewhere");
  if (kind === "traversal") f.value.steps[0]!.path = "../output.txt";
  if (kind === "old-symlink") { value.version = 1; value.steps = [{ ...f.value.steps[0], promoted: { kind: "symlink", mode: 0o777 } }]; }
  await writeFile(f.journal, JSON.stringify(value)); const before = await readFile(f.journal);
  const result = await run(f.project, f.journal, ["--rollback"]);
  expect(result.code).toBe(1); expect(result.stderr || result.stdout).not.toBe("");
  expect(await readFile(join(f.project, "output.txt"), "utf8")).toBe("promoted\n");
  expect(await readFile(f.journal)).toEqual(before);
});

it("rejects conflicting recovery modes as a usage error", async () => {
  const f = await fixture(); const result = await run(f.project, f.journal, ["--dry-run", "--rollback"]);
  expect(result.code).toBe(2); expect(await readFile(join(f.project, "output.txt"), "utf8")).toBe("promoted\n");
});

it.each([
  ".git/config", ".atomic-agent/rules.json", "pkg/.atomic-agent/rules.json", "pkg/.ATOMIC-AGENT./rules.json",
  "C:/outside.txt", "//server/share/out.txt", "..\\outside.txt", "output.txt:stream", "CON", "output.txt.",
])("rejects out-of-scope or platform-ambiguous step path %s before mutation", async path => {
  const f = await fixture(); f.value.steps[0]!.path = path; await writeFile(f.journal, JSON.stringify(f.value));
  const before = await readFile(f.journal);
  const result = await run(f.project, f.journal, ["--rollback"]);
  expect(result.code).toBe(1);
  expect(await readFile(join(f.project, "output.txt"), "utf8")).toBe("promoted\n");
  expect(await readFile(f.journal)).toEqual(before);
});

it.each(["backup-traversal", "duplicate-path", "missing-hash", "unknown-status", "unknown-temp"])("validates the complete journal before rollback: %s", async kind => {
  const f = await fixture(); const step = f.value.steps[0]!;
  const value = f.value as unknown as { steps: Record<string, unknown>[] };
  if (kind === "backup-traversal") step.backup = "../outside.txt";
  if (kind === "duplicate-path") value.steps.push({ ...value.steps[0] });
  if (kind === "missing-hash") delete (value.steps[0]!.promoted as Record<string, unknown>).sha256;
  if (kind === "unknown-status") value.steps[0]!.status = "do-whatever";
  if (kind === "unknown-temp") value.steps[0]!.temp = "unrelated-user-file.txt";
  await writeFile(f.journal, JSON.stringify(value)); const before = await readFile(f.journal);
  const result = await run(f.project, f.journal, ["--rollback"]);
  expect(result.code).toBe(1);
  expect(await readFile(join(f.project, "output.txt"), "utf8")).toBe("promoted\n");
  expect(await readFile(f.journal)).toEqual(before);
});

it("preserves a later symlink retarget instead of restoring through or replacing it", async () => {
  const f = await fixture();
  const target = join(f.project, "target"), editedTarget = join(f.project, "user-target");
  await mkdir(target); await mkdir(editedTarget);
  const link = join(f.project, "link");
  await symlink(editedTarget, link, process.platform === "win32" ? "junction" : "dir");
  const value = { ...f.value, steps: [{ path: "link", action: "write", status: "applied", original: null,
    promoted: { kind: "symlink", mode: (await lstat(link)).mode & 0o777, linkTarget: target } }] };
  await writeFile(f.journal, JSON.stringify(value));
  const result = await run(f.project, f.journal, ["--rollback"]);
  expect(result.code).toBe(1); expect(result.stdout + result.stderr).toContain("link");
  expect(await readlink(link)).toContain("user-target");
});

it("refuses linked output ancestors and does not touch their outside targets", async () => {
  const f = await fixture(); const outside = await mkdtemp(join(tmpdir(), "atag-recovery-outside-")); roots.push(outside);
  await writeFile(join(outside, "output.txt"), "promoted\n");
  await symlink(outside, join(f.project, "linked"), process.platform === "win32" ? "junction" : "dir");
  f.value.steps[0]!.path = "linked/output.txt"; await writeFile(f.journal, JSON.stringify(f.value));
  const before = await readFile(f.journal); const result = await run(f.project, f.journal, ["--rollback"]);
  expect(result.code).toBe(1); expect(await readFile(join(outside, "output.txt"), "utf8")).toBe("promoted\n");
  expect(await readFile(f.journal)).toEqual(before);
});

it("keeps a created directory containing a later user file", async () => {
  const f = await fixture(); await mkdir(join(f.project, "created")); await writeFile(join(f.project, "created", "user.txt"), "user bytes");
  const value = { ...f.value, steps: [{ path: "created", action: "mkdir", status: "applied", original: null,
    promoted: { kind: "directory", mode: (await lstat(join(f.project, "created"))).mode & 0o777 } }] };
  await writeFile(f.journal, JSON.stringify(value));
  const result = await run(f.project, f.journal, ["--rollback"]);
  expect(result.code).toBe(1); expect(await readFile(join(f.project, "created", "user.txt"), "utf8")).toBe("user bytes");
});

it("plans and restores an original directory deleted after its child, then repeats as a terminal receipt", async () => {
  const f = await fixture();
  const value = { ...f.value, steps: [
    { ...f.value.steps[0], path: "gone/a.txt", action: "delete", promoted: null },
    { path: "gone", action: "rmdir", status: "applied", original: { kind: "directory", mode: (await lstat(f.project)).mode & 0o777 }, promoted: null },
  ] };
  await writeFile(f.journal, JSON.stringify(value)); const before = await readFile(f.journal);
  for (const args of [["--status"], ["--dry-run"]]) {
    const result = await run(f.project, f.journal, args); expect(result.code, result.stderr).toBe(0);
    expect(await readFile(f.journal)).toEqual(before); await expect(lstat(join(f.project, "gone"))).rejects.toThrow();
  }
  const restored = await run(f.project, f.journal, ["--rollback"]); expect(restored.code, restored.stderr).toBe(0);
  expect(await readFile(join(f.project, "gone", "a.txt"), "utf8")).toBe("original\n");
  await writeFile(join(f.project, "gone", "a.txt"), "later user edit\n");
  const repeated = await run(f.project, f.journal, ["--rollback"]); expect(repeated.code, repeated.stderr).toBe(0);
  expect(await readFile(join(f.project, "gone", "a.txt"), "utf8")).toBe("later user edit\n");
});

it.each(["rolled-back", "not-applied"])("does not revisit terminal step %s during a later conflict retry", async status => {
  const f = await fixture();
  const value = { ...f.value, state: "rolled-back-with-conflicts", steps: [
    { ...f.value.steps[0], status },
    { ...f.value.steps[0], path: "other.txt", status: "rollback-conflict" },
  ] };
  // The first path is a later user edit that happens to match promoted bytes.
  await writeFile(join(f.project, "other.txt"), "user conflict\n"); await writeFile(f.journal, JSON.stringify(value));
  const result = await run(f.project, f.journal, ["--rollback"]);
  expect(result.code).toBe(1);
  expect(await readFile(join(f.project, "output.txt"), "utf8")).toBe("promoted\n");
  expect(await readFile(join(f.project, "other.txt"), "utf8")).toBe("user conflict\n");
});

it("retains an unattested partial staging file while restoring its verified target with a fresh temp", async () => {
  const f = await fixture(), temp = ".atag-candidate-0123456789abcdef";
  const value = { ...f.value, steps: [{ ...f.value.steps[0], temp, tempEntry: f.value.steps[0]!.promoted }] };
  await writeFile(join(f.project, temp), "partial or later user staging edit\n"); await writeFile(f.journal, JSON.stringify(value));
  const preview = await run(f.project, f.journal, ["--dry-run"]);
  expect(preview.code, preview.stderr).toBe(0); expect(JSON.parse(preview.stdout).retainedStaging).toContain(temp);
  const restored = await run(f.project, f.journal, ["--rollback"]);
  expect(restored.code, restored.stderr).toBe(0); expect(JSON.parse(restored.stdout).retainedStaging).toContain(temp);
  expect(await readFile(join(f.project, "output.txt"), "utf8")).toBe("original\n");
  expect(await readFile(join(f.project, temp), "utf8")).toBe("partial or later user staging edit\n");
});
