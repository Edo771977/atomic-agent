/** Privacy-safe final candidate evidence. Declared input integrity is not operator approval or transitive coverage. */
export type CandidateRejectionReason = "checks-failed" | "checks-unverified" | "check-inputs-changed" | "payload-changed" | "provides-unverified" | "task-not-ok" | "original-changed" | "delivery-failed" | "interrupted" | "other";

export interface CandidateAcceptanceReceipt {
  version: 1;
  /** Runtime-generated opaque identity, never a path or task identifier. */
  id: string;
  disposition: "promoted" | "rejected" | "unchanged";
  checkScope: "declared" | "protected-declared";
  checkStatus: "passed" | "failed" | "unverified";
  checks: { total: number; passed: number; failed: number };
  inputs: { declared: number; verified: number };
  /** SHA256 of the authoritative checked file inventory, excluding documented disposable entries. */
  checkedPayloadDigest?: string;
  /** SHA256 of the declared check plan, not the command text. */
  checkPlanDigest?: string;
  reason?: CandidateRejectionReason;
}
