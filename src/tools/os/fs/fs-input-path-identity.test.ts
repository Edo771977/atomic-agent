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
  expect(registry.inputsOf("worker")).toEqual(process.platform === "win32" ? [upper] : [upper, lower]);
});
