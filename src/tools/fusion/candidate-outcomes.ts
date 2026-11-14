import type { CandidateAcceptanceReceipt, CandidateRejectionReason } from "./candidate-acceptance.js";
import type { ContractCheckOutcome } from "./contract-checks.js";
import type { TaskOutcomeRecord } from "./outcome-log.js";

export interface CandidateCheckCounts { total: number; passed: number; failed: number }
export interface CandidateOutcomeEvidence {
  /** Missing when the final receipt was invalid; the candidate discriminator remains. */
  receipt?: CandidateAcceptanceReceipt;
  /** Only final reruns explicitly attributed to this task, never call-level integration checks. */
  taskChecks: CandidateCheckCounts;
}

const REASONS: readonly CandidateRejectionReason[] = ["checks-failed", "checks-unverified", "check-inputs-changed", "payload-changed", "provides-unverified", "task-not-ok", "original-changed", "delivery-failed", "interrupted", "other"];
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function counts(value: unknown): CandidateCheckCounts | undefined {
  if (!object(value) || !count(value.total) || !count(value.passed) || !count(value.failed) || value.passed + value.failed > value.total) return undefined;
  return { total: value.total, passed: value.passed, failed: value.failed };
}

/** Reconstruct only bounded fixed-category fields, never a receipt's incidental prose. */
function safeReceipt(value: unknown): CandidateAcceptanceReceipt | undefined {
  if (!object(value) || value.version !== 1 || typeof value.id !== "string" || !/^[a-f0-9]{24}$/.test(value.id) ||
      !["promoted", "rejected", "unchanged"].includes(String(value.disposition)) ||
      !["declared", "protected-declared"].includes(String(value.checkScope)) ||
      !["passed", "failed", "unverified"].includes(String(value.checkStatus))) return undefined;
  const checked = counts(value.checks);
  const inputs = value.inputs;
  if (checked === undefined || !object(inputs) || !count(inputs.declared) || !count(inputs.verified) || inputs.verified > inputs.declared ||
      (value.checkedPayloadDigest !== undefined && !digest(value.checkedPayloadDigest)) ||
      (value.checkPlanDigest !== undefined && !digest(value.checkPlanDigest)) ||
      (value.reason !== undefined && !REASONS.includes(value.reason as CandidateRejectionReason))) return undefined;
  if ((value.checkStatus === "passed" && (checked.total === 0 || checked.passed !== checked.total || checked.failed !== 0)) ||
      (value.checkStatus === "failed" && checked.failed === 0) ||
      (value.disposition !== "rejected" && (value.checkStatus !== "passed" || inputs.declared !== inputs.verified || value.reason !== undefined))) return undefined;
  return {
    version: 1, id: value.id, disposition: value.disposition as CandidateAcceptanceReceipt["disposition"],
    checkScope: value.checkScope as CandidateAcceptanceReceipt["checkScope"], checkStatus: value.checkStatus as CandidateAcceptanceReceipt["checkStatus"],
    checks: checked, inputs: { declared: inputs.declared, verified: inputs.verified },
    ...(value.checkedPayloadDigest === undefined ? {} : { checkedPayloadDigest: value.checkedPayloadDigest as string }),
    ...(value.checkPlanDigest === undefined ? {} : { checkPlanDigest: value.checkPlanDigest as string }),
    ...(value.reason === undefined ? {} : { reason: value.reason as CandidateRejectionReason }),
  };
}

/** Presence, including malformed or unknown metadata, always excludes direct quality evidence. */
export const hasCandidateOutcome = (row: TaskOutcomeRecord): boolean => "candidate" in row;

export function candidateOutcomeEvidence(row: TaskOutcomeRecord): CandidateOutcomeEvidence | undefined {
  if (!object(row.candidate)) return undefined;
  const receipt = safeReceipt(row.candidate.receipt);
  const taskChecks = counts(row.candidate.taskChecks);
  if (receipt === undefined || taskChecks === undefined || taskChecks.total > receipt.checks.total ||
      taskChecks.passed > receipt.checks.passed || taskChecks.failed > receipt.checks.failed) return undefined;
  return { receipt, taskChecks };
}

/** Final disposition is telemetry: even promoted candidates never train per-model quality rates. */
export function withCandidateOutcome(
  record: TaskOutcomeRecord, receipt: CandidateAcceptanceReceipt,
  finalTaskChecks: readonly Pick<ContractCheckOutcome, "task" | "ok">[], taskId: string,
): TaskOutcomeRecord {
  const safe = safeReceipt(receipt);
  const taskChecks = { total: 0, passed: 0, failed: 0 };
  // The public contract permits sixteen checks. Leave unexpected huge inputs unverified.
  if (finalTaskChecks.length <= 1024) for (const check of finalTaskChecks) {
    if (check.task !== taskId || typeof check.ok !== "boolean") continue;
    taskChecks.total += 1;
    if (check.ok) taskChecks.passed += 1;
    else taskChecks.failed += 1;
  }
  return { ...record, candidate: { ...(safe === undefined ? {} : { receipt: safe }), taskChecks } };
}
