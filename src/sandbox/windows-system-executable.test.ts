import { describe, expect, it } from "vitest";
import { windowsCommandInterpreter, windowsSystemExecutable } from "./windows-system-executable.js";

describe("Windows system executables", () => {
  it("uses the host root case-insensitively, independent of PATH and cwd", () => {
    expect(windowsSystemExecutable("taskkill.exe", { SYSTEMROOT: "D:\\Host Windows", PATH: "" }))
      .toBe("D:\\Host Windows\\System32\\taskkill.exe");
    expect(windowsSystemExecutable("cmd.exe", { WINDIR: "E:\\WinNT" }))
      .toBe("E:\\WinNT\\System32\\cmd.exe");
  });

  it.each([undefined, "", "Windows", "\\Windows", "C:Windows", "C:\\bad\nroot"])(
    "never uses root %j relative to cwd", (SystemRoot) => {
      expect(windowsSystemExecutable("taskkill.exe", { SystemRoot }))
        .toBe("C:\\Windows\\System32\\taskkill.exe");
    },
  );

  it.each(["cmd.exe", "tools\\cmd.exe", "\\tools\\cmd.exe", "C:cmd.exe", '"C:\\Windows\\cmd.exe"'])(
    "refuses unqualified interpreter %j and ignores the command's root", (ComSpec) => {
      expect(windowsCommandInterpreter(
        { ComSpec, SystemRoot: "C:\\project\\fake-system" },
        { SystemRoot: "D:\\Host Windows" },
      )).toBe("D:\\Host Windows\\System32\\cmd.exe");
    },
  );

  it.each(["D:\\Custom Shell\\cmd.exe", "\\\\server\\share\\cmd.exe", "\\\\?\\C:\\Windows\\System32\\cmd.exe"])(
    "preserves explicitly configured qualified interpreter %j", (COMSPEC) => {
      expect(windowsCommandInterpreter({ COMSPEC }, { SystemRoot: "D:\\Host Windows" })).toBe(COMSPEC);
    },
  );
});
