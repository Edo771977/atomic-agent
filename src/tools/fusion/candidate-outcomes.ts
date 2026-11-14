import type { CandidateAcceptanceReceipt } from "./candidate-acceptance.js";
import { parseCandidateAcceptanceReceipt } from "./candidate-receipt.js";
import type { ContractCheckOutcome } from "./contract-checks.js";
import type { TaskOutcomeRecord } from "./outcome-log.js";

export interface CandidateCheckCounts { total: number; passed: number; failed: number }
export interface CandidateOutcomeEvidence {
  /** Missing when the final receipt was invalid; the candidate discriminator remains. */
  receipt?: CandidateAcceptanceReceipt;
  /** Only final reruns explicitly attributed to this task, never call-level integration checks. */
  taskChecks: CandidateCheckCounts;
  /** Actual worker task invocations, including judge retries; absent means unknown, never one. */
  workerRuns?: number;
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;
function counts(value: unknown): CandidateCheckCounts | undefined {
  if (!object(value) || !count(value.total) || !count(value.passed) || !count(value.failed) || value.passed + value.failed > value.total) return undefined;
  return { total: value.total, passed: value.passed, failed: value.failed };
}

/** Presence, including malformed or unknown metadata, always excludes direct quality evidence. */
export const hasCandidateOutcome = (row: TaskOutcomeRecord): boolean => "candidate" in row;

export function candidateOutcomeEvidence(row: TaskOutcomeRecord): CandidateOutcomeEvidence | undefined {
  if (!object(row.candidate)) return undefined;
  const receipt = parseCandidateAcceptanceReceipt(row.candidate.receipt);
  const taskChecks = counts(row.candidate.taskChecks);
  if (receipt === undefined || taskChecks === undefined || taskChecks.total > receipt.checks.total ||
      taskChecks.passed > receipt.checks.passed || taskChecks.failed > receipt.checks.failed) return undefined;
  return { receipt, taskChecks, ...(count(row.candidate.workerRuns) && row.candidate.workerRuns > 0 ? { workerRuns: row.candidate.workerRuns } : {}) };
}

/** Final disposition is telemetry: even promoted candidates never train per-model quality rates. */
export function withCandidateOutcome(
  record: TaskOutcomeRecord, receipt: CandidateAcceptanceReceipt,
  finalTaskChecks: readonly Pick<ContractCheckOutcome, "task" | "ok">[], taskId: string, actualWorkerRuns?: number,
): TaskOutcomeRecord {
  const safe = parseCandidateAcceptanceReceipt(receipt);
  const taskChecks = { total: 0, passed: 0, failed: 0 };
  // The public contract permits sixteen checks. Leave unexpected huge inputs unverified.
  if (finalTaskChecks.length <= 1024) for (const check of finalTaskChecks) {
    if (check.task !== taskId || typeof check.ok !== "boolean") continue;
    taskChecks.total += 1;
    if (check.ok) taskChecks.passed += 1;
    else taskChecks.failed += 1;
  }
  return { ...record, candidate: { ...(safe === undefined ? {} : { receipt: safe }), taskChecks,
    ...(count(actualWorkerRuns) && actualWorkerRuns > 0 ? { workerRuns: actualWorkerRuns } : {}) } };
}
