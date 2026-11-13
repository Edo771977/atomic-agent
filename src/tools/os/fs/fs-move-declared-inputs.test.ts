import { expect, it } from "vitest";
import { declaredInputTouched } from "./fs-move.js";

const move = (source: string, dest: string, folder = false) => ({ source, dest, folder });

it("protects a declared input under Windows path identity, as os.fs.write does", () => {
  const input = "C:\\proj\\input.txt";
  expect(declaredInputTouched([move("c:\\PROJ\\Input.TXT", "C:\\proj\\out.txt")], [input], "win32")).toBe(input);
  expect(declaredInputTouched([move("C:\\proj\\other.txt", "c:/PROJ/INPUT.txt")], [input], "win32")).toBe(input);
  expect(declaredInputTouched([move("c:\\Proj", "D:\\moved", true)], [input], "win32")).toBe(input);
  expect(declaredInputTouched([move("C:\\proj\\input.txt.", "C:\\proj\\out.txt")], [input], "win32")).toBe(input);
  expect(declaredInputTouched([move("C:\\proj\\other.txt", "C:\\proj\\input.txt::$DATA")], [input], "win32")).toBe(input);
  expect(declaredInputTouched([move("C:\\proj\\other.txt", "C:\\proj\\out.txt")], [input], "win32")).toBeUndefined();
});

it("keeps POSIX case-distinct paths distinct", () => {
  expect(declaredInputTouched([move("/proj/Input.txt", "/proj/out.txt")], ["/proj/input.txt"], "linux")).toBeUndefined();
  expect(declaredInputTouched([move("/proj", "/moved", true)], ["/proj/input.txt"], "linux")).toBe("/proj/input.txt");
  expect(declaredInputTouched([move("/proj/a", "/proj/input.txt")], ["/proj/input.txt"], "linux")).toBe("/proj/input.txt");
});
