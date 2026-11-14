import { expect, it } from "vitest";
import { rebaseVerifyWorkspaceValue as rebase } from "./rebase-verify-workspace.js";

it.each(["<", ":", "|", "&", "@", "+"])("rebases an explicit project literal after %s", prefix => {
  expect(rebase(`${prefix}/project/a.txt`, "/project", "/checked", "linux")).toBe(`${prefix}/checked/a.txt`);
});

it.each(["-C", "-I"])("rebases an attached short option %s without changing its prefix", prefix => {
  expect(rebase(`tool ${prefix}/project`, "/project", "/checked", "linux")).toBe(`tool ${prefix}/checked`);
  expect(rebase(`${prefix}/project/include`, "/project", "/checked", "linux")).toBe(`${prefix}/checked/include`);
});

it("recognizes attached Windows drive paths without consuming the drive as an option", () => {
  expect(rebase(String.raw`tool -IC:\project\include -CC:\project`, String.raw`C:\project`, String.raw`E:\checked`, "win32")).toBe(String.raw`tool -IE:\checked\include -CE:\checked`);
  expect(() => rebase(String.raw`tool -LC:\project\lib`, String.raw`C:\project`, String.raw`E:\checked`, "win32")).toThrow(/unsupported absolute project reference/);
});

it("rebases every path-list segment without mistaking a Windows drive colon for a separator", () => {
  expect(rebase("PATH=/project/bin:/project/node_modules/.bin", "/project", "/checked", "linux")).toBe("PATH=/checked/bin:/checked/node_modules/.bin");
  expect(rebase("PYTHONPATH=/external:/project/lib", "/project", "/checked", "linux")).toBe("PYTHONPATH=/external:/checked/lib");
  expect(rebase(String.raw`PATH=C:\external;C:\project\bin;D:\external`, String.raw`C:\project`, String.raw`E:\checked`, "win32")).toBe(String.raw`PATH=C:\external;E:\checked\bin;D:\external`);
});

it("compares complete quoted literals so paths with spaces and siblings keep their identity", () => {
  expect(rebase('cd "/project space"', "/project", "/checked", "linux")).toBe('cd "/project space"');
  expect(rebase('node "/project space/check.mjs"', "/project space", "/checked space", "linux")).toBe('node "/checked space/check.mjs"');
  expect(rebase('node "/project space-sibling/check.mjs"', "/project space", "/checked", "linux")).toBe('node "/project space-sibling/check.mjs"');
  expect(rebase('tool "/project/body a&b+(1).json"', "/project", "/checked", "linux")).toBe('tool "/checked/body a&b+(1).json"');
});

it("rebases independent repeated references without changing embedded external paths", () => {
  const text = 'tool </project/a.txt -I/project/include @"/project/body file" /backup/project/a.txt /project-sibling/a.txt';
  expect(rebase(text, "/project", "/checked", "linux")).toBe('tool </checked/a.txt -I/checked/include @"/checked/body file" /backup/project/a.txt /project-sibling/a.txt');
});

it.each(["</home/u/./project/a.txt", "-I/home/u/other/../project/a.txt", "@~/project/a.txt", "PATH=/external:/home/u//project/lib"])("refuses an ambiguous source alias after a literal prefix: %s", text => {
  expect(() => rebase(text, "/home/u/project", "/checked", "linux", "/home/u")).toThrow(/unsupported absolute project reference/);
});

it("fails closed for a recognizable source path attached to an unsupported option", () => {
  expect(() => rebase("tool -L/project/lib", "/project", "/checked", "linux")).toThrow(/unsupported absolute project reference/);
  expect(rebase("tool -L/external/lib", "/project", "/checked", "linux")).toBe("tool -L/external/lib");
});

it("refuses recognizable source literals with an unfinished quote or literal controls", () => {
  expect(() => rebase('tool "</project/a.txt', "/project", "/checked", "linux")).toThrow(/unsupported absolute project reference/);
  expect(() => rebase('tool "/project/a\nb.txt"', "/project", "/checked", "linux")).toThrow(/unsupported absolute project reference/);
  expect(rebase('echo "100% ready', "/project", "/checked", "linux")).toBe('echo "100% ready');
});

it("preserves whole non-file URLs and external file URL queries", () => {
  for (const text of ["https://example.com/?path=/project/a.txt", "http://localhost:3000/?next=/project", "file:///external/a.mjs?path=/project/other#tag", "file:///project-sibling/a.mjs?path=/project/other"])
    expect(rebase(text, "/project", "/checked", "linux")).toBe(text);
});

it("preserves ordinary commands, percent labels and unrelated filesystem references", () => {
  for (const text of ["npm test", "pytest", "echo 100%", "console.log('file: 100% ready')", "/backup/project/a.txt", "/project-sibling/a.txt", "git -C/project-sibling", "-I/external/include", "console.log('/backup/project/project/a.txt')"])
    expect(rebase(text, "/project", "/checked", "linux")).toBe(text);
});

it("applies the same finite literal rules to nested command arguments and environments", () => {
  expect(rebase({ cmd: "tool", args: ["-I/project/include"], env: { PYTHONPATH: "/external:/project/lib" } }, "/project", "/checked", "linux")).toEqual({ cmd: "tool", args: ["-I/checked/include"], env: { PYTHONPATH: "/external:/checked/lib" } });
});
