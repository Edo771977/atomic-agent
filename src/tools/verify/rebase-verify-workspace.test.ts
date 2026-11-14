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
it("preserves case-distinct external paths on Linux", () => {
  expect(rebaseVerifyWorkspaceValue("/TMP/project/check.mjs", "/tmp/project", "/tmp/actual", "linux")).toBe("/TMP/project/check.mjs");
});
it.each(["win32", "darwin"] as const)("folds project case only on %s", platform => {
  expect(rebaseVerifyWorkspaceValue("/TMP/project/check.mjs", "/tmp/project", "/tmp/actual", platform)).toBe("/tmp/actual/check.mjs");
});
it("preserves an external path containing the project spelling as a suffix", () => {
  expect(rebaseVerifyWorkspaceValue("/backup/home/u/proj/check.mjs", "/home/u/proj", "/tmp/actual", "linux")).toBe("/backup/home/u/proj/check.mjs");
  expect(rebaseVerifyWorkspaceValue("/home/u/proj-sibling/check.mjs", "/home/u/proj", "/tmp/actual", "linux")).toBe("/home/u/proj-sibling/check.mjs");
});
it.each(["~/proj/check.mjs", "$HOME/proj/check.mjs", "${HOME}/proj/check.mjs", "/home/u//proj/check.mjs", "/home/u/./proj/check.mjs", "/home/u/other/../proj/check.mjs"])("refuses recognized project alias %s before executing an ambiguous plan", alias => {
  expect(() => rebaseVerifyWorkspaceValue(`cd ${alias};`, "/home/u/proj", "/tmp/actual", "linux", "/home/u")).toThrow(/unsupported absolute project reference/);
});
it("preserves explicit external home and normalized sibling paths", () => {
  expect(rebaseVerifyWorkspaceValue("$HOME/elsewhere/check.mjs /home/u//proj-sibling/check.mjs", "/home/u/proj", "/tmp/actual", "linux", "/home/u")).toBe("$HOME/elsewhere/check.mjs /home/u//proj-sibling/check.mjs");
});
it("keeps original left boundaries across repeated embedded external matches", () => {
  const value = "/backup/tmp/project/tmp/project/a.js";
  expect(rebaseVerifyWorkspaceValue(value, "/tmp/project", "/private/checked", "linux")).toBe(value);
});
it("rebases multiple independent project arguments while preserving embedded occurrences", () => {
  const value = "node /backup/tmp/project/tmp/project/a.js '/tmp/project/a.js' /tmp/project/b.js";
  expect(rebaseVerifyWorkspaceValue(value, "/tmp/project", "/private/checked", "linux")).toBe("node /backup/tmp/project/tmp/project/a.js '/private/checked/a.js' /private/checked/b.js");
});
it.each([
  ["linux", "/home/u/my project", "file:///home/u/my%20project/check.mjs"],
  ["linux", "/home/u/project", "file://localhost/home/u/project/check.mjs"],
  ["win32", "C:\\Users\\u\\my project", "file:///C:/Users/u/my%20project/check.mjs"],
  ["win32", "\\\\server\\share\\project", "file://server/share/project/check.mjs"],
  ["win32", "C:\\Users\\u\\my project", "file:/C:/Users/u/my%20project/check.mjs"],
  ["win32", "C:\\Users\\u\\my project", "file:C:/Users/u/my%20project/check.mjs"],
  ["linux", "/home/u/my project", "FiLe:/home/u/my%20project/check.mjs"],
  ["linux", "/home/u/my project", "file:home/u/my%20project/check.mjs"],
  ["linux", "/home/u/my project", "fi\nle:/home/u/my%20project/check.mjs"],
  ["linux", "/home/u/my project", "\u0001file:/home/u/my%20project/check.mjs"],
] as const)("refuses an explicit %s source file URL with native path semantics", (platform, root, url) => {
  expect(() => rebaseVerifyWorkspaceValue(`new URL('${url}')`, root, "/private/checked", platform)).toThrow(/unsupported absolute project reference/);
});
it("preserves external and sibling file URLs", () => {
  const text = "file:///backup/home/u/project/a.js file:///home/u/project-sibling/a.js file:/home/u/project-sibling/a.js file:backup/home/u/project/a.js";
  expect(rebaseVerifyWorkspaceValue(text, "/home/u/project", "/private/checked", "linux")).toBe(text);
});
it.each([
  ["linux", "/home/u/project", "file:///home/u/project/%GG/a.js"],
  ["darwin", "/home/u/my project", "file:/home/u/my%20project/%GG/a.js"],
  ["win32", "C:\\source", "file:C:/sour%63e/%GG/a.js"],
  ["win32", "\\\\server\\share\\project", "file://server/share/project/%GG/a.js"],
] as const)("refuses malformed file URI plans with a recognizable %s source prefix", (platform, root, uri) => {
  expect(() => rebaseVerifyWorkspaceValue(uri, root, "/private/checked", platform)).toThrow(/unsupported absolute project reference/);
});
it("preserves an external literal file URI with WHATWG scheme whitespace", () => {
  const uri = "fi\nle:/backup/home/u/project/a.js";
  expect(rebaseVerifyWorkspaceValue(uri, "/home/u/project", "/private/checked", "linux")).toBe(uri);
});
it("preserves benign multiline code and file labels", () => {
  const code = "console.log('file: ready');\nconsole.log('file:');\nprocess.exit(0);";
  expect(rebaseVerifyWorkspaceValue(code, source, execution)).toBe(code);
});
it.each(["linux", "darwin", "win32"] as const)("preserves percent-bearing file labels on %s", platform => {
  const code = "console.log('file: 100% ready');\nconsole.log('file: ready');";
  expect(rebaseVerifyWorkspaceValue(code, "/source", "/execution", platform)).toBe(code);
  const external = "file:///backup/%GG/a.js";
  expect(rebaseVerifyWorkspaceValue(external, "/source", "/execution", platform)).toBe(external);
});
