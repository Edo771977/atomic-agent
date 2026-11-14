import type { TaskOutcomeRecord } from "./outcome-log.js";

/** Declared checks only. Candidate executions have a separate, success-conditioned scope. */
export function taskCheckEvidence(row: TaskOutcomeRecord): "passed" | "failed" | "unverified" {
  // Even malformed/unknown candidate metadata must not regain legacy direct-task eligibility.
  if ("candidate" in row || row.v !== 1 || row.acceptanceScope !== "task-checks" ||
      !Number.isInteger(row.attempt) || row.attempt < 1 ||
      row.judgeRetried !== false || row.escalations !== 0 ||
      typeof row.selfCheckNotice !== "boolean" || row.syntaxDemoted !== false ||
      (row.merge !== null && row.merge !== "merged") ||
      !["off", "green", "red"].includes(row.judge)) return "unverified";
  if (row.acceptance === "checks-passed" && row.status === "ok" && row.failure === null &&
      (row.judge === "off" || row.judge === "green")) return "passed";
  if (row.acceptance === "checks-failed" && row.status === "failed" && row.failure === "checks") return "failed";
  return "unverified";
}
