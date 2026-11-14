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

it("uses path-list context for relative first entries instead of treating them as URL schemes", () => {
  expect(rebase({ env: { PATH: "bin:/project/bin", PYTHONPATH: "relative:/project/lib" } }, "/project", "/checked", "linux")).toEqual({ env: { PATH: "bin:/checked/bin", PYTHONPATH: "relative:/checked/lib" } });
  expect(rebase({ cmd: "PATH=bin:/project/bin tool" }, "/project", "/checked", "linux")).toEqual({ cmd: "PATH=bin:/checked/bin tool" });
  expect(rebase({ cmd: 'PYTHONPATH="relative:/project space/lib" tool' }, "/project space", "/checked space", "linux")).toEqual({ cmd: 'PYTHONPATH="relative:/checked space/lib" tool' });
});

it("preserves actual URLs and complete sibling names inside known path-list values", () => {
  const value = { env: { PATH: "https://localhost:3000/?next=/project", PYTHONPATH: "/external:/project space", NODE_PATH: "file:///external/a.mjs?next=/project" } };
  expect(rebase(value, "/project", "/checked", "linux")).toEqual(value);
  expect(rebase("custom:/project/a.txt", "/project", "/checked", "linux")).toBe("custom:/project/a.txt");
});

it("refuses a recognizable PowerShell home source alias before splitting its namespace colon", () => {
  const root = String.raw`C:\Users\u\project`;
  expect(() => rebase({ cmd: String.raw`type $env:USERPROFILE\project\a.txt` }, root, String.raw`D:\checked`, "win32", String.raw`C:\Users\u`)).toThrow(/unsupported absolute project reference/);
  expect(rebase({ cmd: String.raw`type $env:USERPROFILE\external\a.txt` }, root, String.raw`D:\checked`, "win32", String.raw`C:\Users\u`)).toEqual({ cmd: String.raw`type $env:USERPROFILE\external\a.txt` });
});

it.each(["curl http://localhost:3000|cat</project/a.txt", "curl http://localhost:3000&&cat</project/a.txt", "echo file:///external/a|cat</project/a.txt"])("ends an unquoted command URL at a shell operator: %s", cmd => {
  expect(rebase({ cmd }, "/project", "/checked", "linux")).toEqual({ cmd: cmd.replace("</project/", "</checked/") });
});

it("keeps URL operators as data in argv, env and quoted URL literals", () => {
  const url = "http://localhost:3000/?a=1&path=/project/a.txt";
  const value = { cmd: `echo '${url}'`, args: [url], env: { LINK: url, PATH: url } };
  expect(rebase(value, "/project", "/checked", "linux")).toEqual(value);
});

it("uses known assignment/environment context for quoted and semicolon path lists", () => {
  expect(rebase({ cmd: 'PATH="/external:/project/bin" tool; PYTHONPATH="/external:/project/lib" python check.py' }, "/project", "/checked", "linux")).toEqual({ cmd: 'PATH="/external:/checked/bin" tool; PYTHONPATH="/external:/checked/lib" python check.py' });
  expect(rebase({ env: { PATH: String.raw`relative;C:\project\bin;D:\external`, PYTHONPATH: String.raw`relative;C:\project\lib` } }, String.raw`C:\project`, String.raw`E:\checked`, "win32")).toEqual({ env: { PATH: String.raw`relative;E:\checked\bin;D:\external`, PYTHONPATH: String.raw`relative;E:\checked\lib` } });
  expect(rebase('tool "/project/x:y;z"', "/project", "/checked", "linux")).toBe('tool "/checked/x:y;z"');
});

it("refuses recognizable POSIX escaped-separator source aliases without evaluating a shell", () => {
  expect(() => rebase(String.raw`tool /project\/a.txt`, "/project", "/checked", "linux")).toThrow(/unsupported absolute project reference/);
  expect(rebase(String.raw`tool /external\/a.txt`, "/project", "/checked", "linux")).toBe(String.raw`tool /external\/a.txt`);
});

it("lets named path-list semantics take precedence over URL-looking first entries", () => {
  expect(rebase({ env: { PATH: "http://external:/project/bin" } }, "/project", "/checked", "linux")).toEqual({ env: { PATH: "http://external:/checked/bin" } });
  expect(rebase({ cmd: 'PATH="https://external:/project/bin" tool' }, "/project", "/checked", "linux")).toEqual({ cmd: 'PATH="https://external:/checked/bin" tool' });
  expect(rebase({ env: { PATH: String.raw`http://external;C:\project\bin` } }, String.raw`C:\project`, String.raw`E:\checked`, "win32")).toEqual({ env: { PATH: String.raw`http://external;E:\checked\bin` } });
});

it("retains named list context in a PowerShell environment assignment", () => {
  expect(rebase({ cmd: String.raw`$env:NODE_PATH='C:\external;C:\project\lib'; & node check.cjs` }, String.raw`C:\project`, String.raw`E:\checked`, "win32")).toEqual({ cmd: String.raw`$env:NODE_PATH='C:\external;E:\checked\lib'; & node check.cjs` });
});

it.each(["echo file:///external/a;/project/tool", "echo https://example.org;/project/tool", "https://example.org;/project/tool"])("ends an unquoted command URL at a semicolon: %s", cmd => {
  expect(rebase({ cmd }, "/project", "/checked", "linux")).toEqual({ cmd: cmd.replace(";/project/", ";/checked/") });
});

it("preserves literal semicolons in quoted URLs, argv URLs and non-list environment URLs", () => {
  const file = "file:///external/a;/project/tool", http = "https://example.org/;/project/tool";
  const value = { cmd: `echo '${file}' "${http}"`, args: [file, http], env: { LINK: http } };
  expect(rebase(value, "/project", "/checked", "linux")).toEqual(value);
});
