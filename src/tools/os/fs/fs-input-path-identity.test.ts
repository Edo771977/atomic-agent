import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { inputPathIdentity } from "./fs-input-path-identity.js";
import { DeclaredInputsRegistry } from "./fs-declared-inputs.js";

it("uses Windows case and separator identity without changing display paths", () => {
  expect(inputPathIdentity("C:/Project/data/../PERSONAL.TXT", "win32")).toBe(inputPathIdentity("c:\\project\\personal.txt", "win32"));
  expect(inputPathIdentity("\\\\Server\\Share\\Personal.TXT", "win32")).toBe(inputPathIdentity("\\\\server\\share\\personal.txt", "win32"));
});

it("keeps differently cased POSIX input paths distinct", () => {
  expect(inputPathIdentity("/project/PERSONAL.TXT", "linux")).not.toBe(inputPathIdentity("/project/personal.txt", "linux"));
  expect(inputPathIdentity("/project/data/../personal.txt", "linux")).toBe("/project/personal.txt");
});

it("deduplicates registry identities using native case rules and retains the first display spelling", () => {
  const upper = join(tmpdir(), "PERSONAL.TXT"), lower = join(tmpdir(), "personal.txt");
  const registry = new DeclaredInputsRegistry(); registry.declare("worker", [upper, lower]);
  expect(registry.inputsOf("worker")).toEqual(process.platform === "win32" || process.platform === "darwin" ? [upper] : [upper, lower]);
});

it("folds Windows trailing dots/spaces and NTFS stream suffixes into the file's identity", () => {
  const input = inputPathIdentity("C:\\proj\\input.txt", "win32");
  for (const alias of ["C:\\proj\\input.txt.", "C:\\proj\\input.txt ", "C:\\proj\\input.txt. .", "C:\\proj.\\input.txt", "C:\\PROJ \\Input.TXT",
    "C:\\proj\\input.txt::$DATA", "C:\\proj\\input.txt::$data", "C:\\proj\\input.txt:extra", "C:\\proj\\input.txt:extra:$DATA", "c:/proj/input.txt.::$DATA"]) {
    expect(inputPathIdentity(alias, "win32"), alias).toBe(input);
  }
  expect(inputPathIdentity("C:\\proj\\input.txt2", "win32")).not.toBe(input);
  expect(inputPathIdentity("C:\\proj\\.input.txt", "win32")).not.toBe(input);
});

it("keeps trailing dots, spaces and colons significant on POSIX", () => {
  expect(inputPathIdentity("/proj/input.txt.", "linux")).not.toBe(inputPathIdentity("/proj/input.txt", "linux"));
  expect(inputPathIdentity("/proj/input.txt::$DATA", "linux")).not.toBe(inputPathIdentity("/proj/input.txt", "linux"));
});

it("folds case (and Unicode normalization) on macOS, where APFS is case-insensitive by default", () => {
  expect(inputPathIdentity("/project/Data.csv", "darwin")).toBe(inputPathIdentity("/project/data.csv", "darwin"));
  expect(inputPathIdentity("/Project/DATA/../Data.CSV", "darwin")).toBe(inputPathIdentity("/project/data.csv", "darwin"));
  // APFS also opens a decomposed spelling as the same file.
  expect(inputPathIdentity("/project/café.txt", "darwin")).toBe(inputPathIdentity("/project/café.txt", "darwin"));
  expect(inputPathIdentity("/project/data.csv.", "darwin")).not.toBe(inputPathIdentity("/project/data.csv", "darwin"));
});
