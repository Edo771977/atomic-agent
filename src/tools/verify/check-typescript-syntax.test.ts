import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkTypeScriptFiles,
  findTsconfig,
  findTscBinary,
  isParseDiagnostic,
  TS_CHECKER,
} from "./check-typescript-syntax.js";

import { installTestTypeScriptCompiler } from "./typescript-test-helpers.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atag-verify-ts-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function project(): Promise<string> {
  await writeFile(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: "ES2022", types: [] },
      include: ["src/**/*.ts"],
    }),
  );
  await mkdir(join(dir, "src"));
  installTestTypeScriptCompiler(dir);
  return dir;
}

describe("findTsconfig / findTscBinary", () => {
  it("walk up from the file's directory", async () => {
    await project();
    await mkdir(join(dir, "src", "deep"));
    expect(findTsconfig(join(dir, "src", "deep"))).toBe(join(dir, "tsconfig.json"));
    expect(findTscBinary(join(dir, "src"))).toBe(join(dir, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc"));
  });
});

describe("checkTypeScriptFiles", () => {
  it("gives no verdict without a tsconfig, and never a pass", async () => {
    const absolute = join(dir, "a.ts");
    await writeFile(absolute, "export const a: number = 1;\n");
    const [out] = await checkTypeScriptFiles([{ file: "a.ts", absolute }]);
    expect(out).toMatchObject({ ok: null, checker: "none" });
    expect(out?.error).toContain("no tsconfig.json");
  });

  it("gives no verdict when the project has no tsc", async () => {
    await writeFile(join(dir, "tsconfig.json"), "{}");
    const absolute = join(dir, "a.ts");
    await writeFile(absolute, "export const a: number = 1;\n");
    const [out] = await checkTypeScriptFiles([{ file: "a.ts", absolute }]);
    expect(out).toMatchObject({ ok: null, checker: "none" });
    expect(out?.error).toContain("no node_modules/.bin/tsc");
  });

  it("runs tsc once per project and attributes diagnostics per file", async () => {
    await project();
    const good = join(dir, "src", "good.ts");
    const bad = join(dir, "src", "bad.ts");
    const outside = join(dir, "outside.ts");
    await writeFile(good, "export const a: number = 1;\n");
    await writeFile(bad, "export const b: number = 'no';\nexport const c = ;\n");
    await writeFile(outside, "export const d: number = 1;\n");
    const out = await checkTypeScriptFiles([
      { file: "src/good.ts", absolute: good },
      { file: "src/bad.ts", absolute: bad },
      { file: "outside.ts", absolute: outside },
    ]);
    expect(out[0]).toMatchObject({ file: "src/good.ts", ok: true, checker: TS_CHECKER });
    expect(out[0]?.warning).toContain("in other files");
    expect(out[1]).toMatchObject({ file: "src/bad.ts", ok: false, checker: TS_CHECKER });
    // tsc withholds semantic diagnostics while a file has parse errors,
    // so the one diagnostic is the parse error, with its line.
    expect(out[1]?.error).toMatch(/line 2: error TS1109/);
    expect(out[2]).toMatchObject({ file: "outside.ts", ok: null, checker: "none" });
    expect(out[2]?.error).toContain("not included by");
    // `--noEmit`: the check left nothing in the project.
    expect((await readdir(dir)).sort()).toEqual(
      ["node_modules", "outside.ts", "src", "tsconfig.json"].sort(),
    );
  }, 60_000);

  it("parseOnly fails a file only on a parse error; type errors are reported beside the pass", async () => {
    await project();
    const typed = join(dir, "src", "typed.ts");
    await writeFile(typed, "export const b: number = 'no';\n");
    const entry = [{ file: "src/typed.ts", absolute: typed }];
    // `verify.syntax` itself: any diagnostic fails the file.
    const [all] = await checkTypeScriptFiles(entry);
    expect(all).toMatchObject({ ok: false, checker: TS_CHECKER });
    const [parse] = await checkTypeScriptFiles(entry, { parseOnly: true });
    expect(parse).toMatchObject({ ok: true, checker: TS_CHECKER, typeErrors: { count: 1 } });
    expect(parse?.typeErrors?.detail).toMatch(/^line 1: error TS2322/);
    expect(parse?.warning).toBeUndefined();
  }, 60_000);
});

describe("isParseDiagnostic", () => {
  it("is the TS1xxx range less the module- and config-dependent codes", () => {
    expect(isParseDiagnostic(1005)).toBe(true);
    expect(isParseDiagnostic(1109)).toBe(true);
    expect(isParseDiagnostic(2322)).toBe(false);
    expect(isParseDiagnostic(2307)).toBe(false);
    expect(isParseDiagnostic(7016)).toBe(false);
    expect(isParseDiagnostic(1192)).toBe(false);
    expect(isParseDiagnostic(1484)).toBe(false);
  });
});
