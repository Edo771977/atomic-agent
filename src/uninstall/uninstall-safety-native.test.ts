import { describe, expect, it } from "vitest";
import { isSafeToRemove } from "./uninstall-targets.js";

describe("uninstall shallow-root safety", () => {
  it.each([
    "C:\\", "C:\\Windows", "C:\\Users", "D:\\data", "C:/Windows/",
    "\\\\server\\share", "\\\\server\\share\\", "\\\\server\\share\\Windows",
  ])("refuses the Windows root or immediate child %s without touching the filesystem", (target) => {
    expect(isSafeToRemove(target, "C:\\Users\\operator", "win32")).toBe(false);
  });

  it.each(["C:\\Users\\operator\\.atomic-agent", "D:\\apps\\atomic-agent", "\\\\server\\share\\operator\\.atomic-agent"])("retains legitimate named app data %s", (target) => {
    expect(isSafeToRemove(target, "C:\\Users\\operator", "win32")).toBe(true);
  });

  it("keeps the POSIX root policy portable", () => {
    expect(isSafeToRemove("/", "/home/operator", "linux")).toBe(false);
    expect(isSafeToRemove("/usr", "/home/operator", "linux")).toBe(false);
    expect(isSafeToRemove("/etc", "/home/operator", "linux")).toBe(false);
    expect(isSafeToRemove("/opt/atomic-agent", "/home/operator", "linux")).toBe(true);
  });

  it("uses the actual host platform by default", () => {
    const target = process.platform === "win32" ? "C:\\Windows" : "/usr";
    const home = process.platform === "win32" ? "C:\\Users\\operator" : "/home/operator";
    expect(isSafeToRemove(target, home)).toBe(false);
  });

  it("matches Windows home paths without case sensitivity while retaining POSIX case distinctions", () => {
    expect(isSafeToRemove("C:\\USERS\\Reviewer", "C:\\Users\\reviewer", "win32")).toBe(false);
    expect(isSafeToRemove("C:/USERS/Reviewer/", "C:\\Users\\reviewer", "win32")).toBe(false);
    expect(isSafeToRemove("\\\\SERVER\\Share\\Reviewer", "\\\\server\\share\\reviewer", "win32")).toBe(false);
    expect(isSafeToRemove("C:\\USERS\\Reviewer\\.atomic-agent", "C:\\Users\\reviewer", "win32")).toBe(true);
    expect(isSafeToRemove("/home/Reviewer", "/home/reviewer", "linux")).toBe(true);
  });

  it.each([
    ["C:\\org\\users", "C:\\org\\users\\reviewer", "win32"],
    ["C:\\ORG\\USERS", "C:\\org\\users\\reviewer", "win32"],
    ["\\\\server\\share\\org\\users", "\\\\SERVER\\Share\\org\\users\\reviewer", "win32"],
    ["/srv/users", "/srv/users/reviewer", "linux"],
  ] as const)("refuses %s because it contains the home directory", (target, home, platform) => {
    expect(isSafeToRemove(target, home, platform)).toBe(false);
  });
});

describe("Windows component aliases of home", () => {
  const home = "C:\\Users\\operator";
  it.each([
    "C:\\Users\\operator.", "C:\\Users\\operator ", "C:\\Users\\operator. .", "C:\\Users.\\operator", "C:\\Users \\operator\\",
    "C:\\Users\\operator::$DATA", "C:\\Users\\operator::$data", "C:\\Users.", "C:\\Users::$DATA",
    "C:\\Users\\OPERAT~1", "C:\\USERS~1\\operator", "C:\\USERS~1",
  ])("refuses %s lexically", target => {
    expect(isSafeToRemove(target, home, "win32")).toBe(false);
  });
  it.each([
    ["C:\\Users\\operator", "C:\\Users\\OPERAT~1"],
    ["C:\\Users", "C:\\USERS~1\\operator"],
    ["C:\\Users\\operator", "C:\\USERS~1\\OPERAT~1"],
  ])("refuses %s when home %s holds a short name that may alias it", (target, shortHome) => {
    expect(isSafeToRemove(target, shortHome, "win32")).toBe(false);
  });
  it("still allows targets deeper than a short-named home", () => {
    expect(isSafeToRemove("C:\\Users\\OPERAT~1\\.atomic-agent", "C:\\Users\\OPERAT~1", "win32")).toBe(true);
  });
  it("still allows ordinary targets inside home and POSIX dot names", () => {
    expect(isSafeToRemove("C:\\Users\\operator.\\.atomic-agent", home, "win32")).toBe(true);
    expect(isSafeToRemove("C:\\Users\\operator2", home, "win32")).toBe(true);
    expect(isSafeToRemove("/home/operator.", "/home/operator", "linux")).toBe(true);
  });
});
