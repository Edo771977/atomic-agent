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
  expect(() => rebaseVerifyWorkspaceValue({ args: [String.raw`C:\\project\\check.mjs`] }, String.raw`C:\project`, String.raw`C:\actual`, "win32")).toThrow(/unsupported absolute project reference/);
});
it("preserves a non-source Windows escaped literal under Linux path semantics", () => {
  const value = { args: [String.raw`C:\\project\\check.mjs`] };
  expect(rebaseVerifyWorkspaceValue(value, String.raw`C:\project`, String.raw`C:\actual`, "linux")).toEqual(value);
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
] as const)("rebases an explicit %s source file URL with native path semantics", (platform, root, url) => {
  const target = platform === "win32" ? String.raw`D:\private\checked` : "/private/checked";
  const expected = platform === "win32" ? "file:///D:/private/checked/check.mjs" : "file:///private/checked/check.mjs";
  expect(rebaseVerifyWorkspaceValue(`new URL('${url}')`, root, target, platform)).toBe(`new URL('${expected}')`);
});
it.each(["fi\nle:/home/u/my%20project/check.mjs", "\u0001file:/home/u/my%20project/check.mjs"])("refuses a source file URL whose scheme relies on literal control normalization", url => {
  expect(() => rebaseVerifyWorkspaceValue(url, "/home/u/my project", "/private/checked", "linux")).toThrow(/unsupported absolute project reference/);
});
it("rebases file URL pathnames while preserving encoded suffixes, queries and fragments", () => {
  const url = "file:///home/u/my%20project/%66ile%20%23%25.mjs?input=%2Fhome%2Fu%2Fmy%20project#same%20tag";
  expect(rebaseVerifyWorkspaceValue(`import('${url}')`, "/home/u/my project", "/checked space", "linux")).toBe("import('file:///checked%20space/%66ile%20%23%25.mjs?input=%2Fhome%2Fu%2Fmy%20project#same%20tag')");
});
it("compares file URL identity with native platform case rules", () => {
  expect(rebaseVerifyWorkspaceValue("file:///C:/PROJECT/a.mjs", String.raw`C:\project`, String.raw`D:\checked`, "win32")).toBe("file:///D:/checked/a.mjs");
  expect(rebaseVerifyWorkspaceValue("file:///PROJECT/a.mjs", "/project", "/checked", "darwin")).toBe("file:///checked/a.mjs");
  expect(rebaseVerifyWorkspaceValue("file:///PROJECT/a.mjs", "/project", "/checked", "linux")).toBe("file:///PROJECT/a.mjs");
});
it("constructs UNC destination file URLs and preserves encoded suffixes", () => {
  expect(rebaseVerifyWorkspaceValue("file://server/share/project/a%20b.mjs?q=1#part", String.raw`\\server\share\project`, String.raw`\\target\private share\checked`, "win32")).toBe("file://target/private%20share/checked/a%20b.mjs?q=1#part");
});
it("encodes apostrophes introduced by a destination URL prefix so single-quoted import code stays valid", () => {
  const code = rebaseVerifyWorkspaceValue("import('file:///project/a%27b.mjs?keep=%27#same')", "/project", "/tmp/O'Neil/checked", "linux");
  expect(code).toBe("import('file:///tmp/O%27Neil/checked/a%27b.mjs?keep=%27#same')");
  expect(() => new Function(code)).not.toThrow();
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
