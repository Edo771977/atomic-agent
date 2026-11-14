import { expect, it } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { rebaseVerifyWorkspaceValue } from "./rebase-verify-workspace.js";

const source = resolve(join(tmpdir(), "source{literal}")), execution = resolve(join(tmpdir(), "actual{literal}"));
it("rebases explicit absolute project arguments while preserving external executables and siblings", () => {
  const value = { cmd: process.execPath, args: [join(source, "check.mjs"), `${source}-sibling/tool`, "relative.mjs"], nested: { cwd: source } };
  expect(rebaseVerifyWorkspaceValue(value, source, execution)).toEqual({ cmd: process.execPath, args: [join(execution, "check.mjs"), `${source}-sibling/tool`, "relative.mjs"], nested: { cwd: execution } });
  expect(value.args[0]).toBe(join(source, "check.mjs"));
});
it("treats literal braces and brackets as path characters instead of patterns", () => {
  expect(rebaseVerifyWorkspaceValue(join(source, "[file].mjs"), source, execution)).toBe(join(execution, "[file].mjs"));
});
it("rebases a project root terminated by a shell or template delimiter", () => {
  expect(rebaseVerifyWorkspaceValue(`cd '${source}';`, source, execution)).toBe(`cd '${execution}';`);
  expect(rebaseVerifyWorkspaceValue(`const root = \`${source}\`;`, source, execution)).toBe(`const root = \`${execution}\`;`);
});
it("refuses escaped Windows project references instead of reading the source outside the guarded copy", () => {
  expect(() => rebaseVerifyWorkspaceValue({ args: [String.raw`C:\\project\\check.mjs`] }, String.raw`C:\project`, String.raw`C:\actual`)).toThrow(/unsupported absolute project reference/);
});
