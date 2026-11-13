import { describe, expect, it } from "vitest";
import { checkShellCommandGuard } from "../index.js";

function guard(rawArgs: readonly string[]) {
  return checkShellCommandGuard({ cmd: "gh", rawArgs, cwd: "/tmp" });
}

describe("gh.read_only with flags joined to their values", () => {
  it.each([
    [["api", "-XDELETE", "repos/o/r"]],
    [["api", "-XPOST", "repos/o/r/issues"]],
    [["api", "-iXPATCH", "repos/o/r"]],
    [["api", "--field=a=b", "repos/o/r/issues"]],
    [["api", "--raw-field=a=b", "repos/o/r/issues"]],
    [["api", "--input=payload.json", "repos/o/r/issues"]],
    [["api", "-fbody=x", "repos/o/r/issues"]],
    [["api", "-Fa=b", "repos/o/r/issues"]],
    [["api", "-if", "a=b", "repos/o/r/issues"]],
  ])("requires approval for a gh api write %j", (rawArgs) => {
    expect(guard(rawArgs).action).toBe("approval_required");
  });

  it.each([
    [["api", "-XGET", "repos/o/r"]],
    [["api", "-X", "HEAD", "repos/o/r"]],
    [["api", "--method=GET", "repos/o/r"]],
    [["api", "-i", "repos/o/r"]],
  ])("still allows a gh api read %j", (rawArgs) => {
    expect(guard(rawArgs)).toMatchObject({ action: "allow", rule: "gh.api_read" });
  });
});

describe("gh auth status never prints the token unasked", () => {
  it.each([
    [["auth", "status", "--show-token"]],
    [["auth", "status", "--show-token=true"]],
    [["auth", "status", "-t"]],
    [["auth", "status", "-at"]],
  ])("requires approval for %j", (rawArgs) => {
    expect(guard(rawArgs).action).toBe("approval_required");
  });

  it("still allows a plain gh auth status", () => {
    expect(guard(["auth", "status"]).action).toBe("allow");
    expect(guard(["auth", "status", "--hostname", "github.com"]).action).toBe(
      "allow",
    );
  });
});
