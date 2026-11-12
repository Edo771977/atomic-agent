import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApprovalGate } from "../../../approval/approval-gate.js";
import { requireFsApproval } from "./fs-require-approval.js";

describe("requireFsApproval and the project's saved rules", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fs-require-approval-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function categoryOfWrite(path: string): Promise<string> {
    const gate = new ApprovalGate({
      level: 4,
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    const outcome = await requireFsApproval(
      { approvals: gate, approvalRequired: true },
      { kind: "write", paths: [path], sessionId: "s", tool: "os.fs.write", reason: "r", workingDir: dir },
      new AbortController().signal,
    );
    return outcome.category;
  }

  it("treats a write of the project rules file as trust_config", async () => {
    expect(await categoryOfWrite(join(dir, ".atomic-agent", "approval-rules.json"))).toBe("trust_config");
  });

  it("leaves other workspace files alone", async () => {
    expect(await categoryOfWrite(join(dir, "notes.txt"))).toBe("fs_write_workspace");
  });
});

describe("requireFsApproval and `other` session grants", () => {
  // Off the home directory and any workspace: the `other` bucket.
  const outsideA = "/srv/atomic-agent-grant-test-a";
  const outsideB = "/srv/atomic-agent-grant-test-b";

  function grantingGate(asked: string[]): ApprovalGate {
    const gate = new ApprovalGate({
      level: 3,
      emit: (req) => {
        asked.push(req.affectedResources?.[0] ?? "");
        gate.resolve({ approvalId: req.approvalId, approved: true, grant: "category" });
      },
    });
    return gate;
  }

  async function ask(
    gate: ApprovalGate,
    kind: "write" | "trash" | "extract",
    tool: string,
    path: string,
  ): Promise<string> {
    const outcome = await requireFsApproval(
      { approvals: gate, approvalRequired: true },
      {
        kind,
        paths: [path],
        sessionId: "s",
        tool,
        reason: "r",
        affectedResources: [path],
        workingDir: tmpdir(),
      },
      new AbortController().signal,
    );
    return outcome.category;
  }

  it("covers the target's directory only", async () => {
    const asked: string[] = [];
    const gate = grantingGate(asked);
    expect(await ask(gate, "trash", "os.fs.trash", join(outsideA, "x"))).toBe("other");
    await ask(gate, "trash", "os.fs.trash", join(outsideA, "y"));
    expect(asked).toEqual([join(outsideA, "x")]);
    await ask(gate, "trash", "os.fs.trash", join(outsideB, "z"));
    await ask(gate, "trash", "os.fs.trash", join(outsideA, "sub", "w"));
    expect(asked).toEqual([join(outsideA, "x"), join(outsideB, "z"), join(outsideA, "sub", "w")]);
  });

  it("keys an extraction by its destination and stays per tool", async () => {
    const asked: string[] = [];
    const gate = grantingGate(asked);
    await ask(gate, "extract", "os.fs.archive.extract", outsideA);
    await ask(gate, "extract", "os.fs.archive.extract", outsideA);
    await ask(gate, "extract", "os.fs.archive.extract", outsideB);
    // The trash grant's directory is not the write tool's.
    await ask(gate, "write", "os.fs.write", join(outsideA, "f"));
    expect(asked).toEqual([outsideA, outsideB, join(outsideA, "f")]);
  });
});
