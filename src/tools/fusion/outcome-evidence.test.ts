import { describe, expect, it } from "vitest";
import { taskCheckEvidence } from "./outcome-evidence.js";
import type { TaskOutcomeRecord } from "./outcome-log.js";

const accepted = { v: 1, acceptance: "checks-passed", acceptanceScope: "task-checks", status: "ok", failure: null,
  attempt: 1, judgeRetried: false, escalations: 0, selfCheckNotice: false, syntaxDemoted: false, merge: null, judge: "off" } as TaskOutcomeRecord;
describe("shared task-check evidence", () => {
  it("preserves later replan report evidence and permits a check failure despite judge red", () => {
    expect(taskCheckEvidence({ ...accepted, attempt: 2, selfCheckNotice: true })).toBe("passed");
    expect(taskCheckEvidence({ ...accepted, acceptance: "checks-failed", status: "failed", failure: "checks", judge: "red" })).toBe("failed");
  });
  it("fails closed on inconsistent, missing, unknown and candidate fields", () => {
    for (const over of [{ v: 2 }, { attempt: 0 }, { attempt: 1.5 }, { judge: "unverified" }, { judge: "red" }, { judge: undefined },
      { syntaxDemoted: undefined }, { syntaxDemoted: true }, { merge: "held" }, { merge: "conflict" }, { merge: undefined },
      { selfCheckNotice: undefined }, { failure: "checks" }, { status: "failed" }, { judgeRetried: true }, { escalations: 1 },
      { acceptanceScope: "candidate-checks" }, { candidate: undefined }, { candidate: null }, { candidate: {} }]) {
      expect(taskCheckEvidence({ ...accepted, ...over } as TaskOutcomeRecord), JSON.stringify(over)).toBe("unverified");
    }
    expect(taskCheckEvidence({ ...accepted, acceptance: "checks-failed", status: "failed", failure: "checks", judge: "unverified" })).toBe("unverified");
  });
});
