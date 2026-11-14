import type { CandidateAcceptanceReceipt, CandidateRejectionReason } from "./candidate-acceptance.js";

const REASONS: readonly CandidateRejectionReason[] = ["checks-failed", "checks-unverified", "check-inputs-changed", "payload-changed", "provides-unverified", "task-not-ok", "original-changed", "delivery-failed", "interrupted", "other"];
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const oneOf = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === "string" && values.includes(value as T);

/** Read own data properties only. Never invoke a caller's getters or retain its prototype. */
function data(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) return undefined;
    result[key] = descriptor.value;
  }
  return result;
}

/** One full-receipt boundary for telemetry and artifact projection; unknown input is unverified. */
export function parseCandidateAcceptanceReceipt(value: unknown): CandidateAcceptanceReceipt | undefined {
  try {
    const receipt = data(value);
    if (receipt === undefined || receipt.version !== 1 || typeof receipt.id !== "string" || !/^[a-f0-9]{24}$/.test(receipt.id) ||
        !oneOf(receipt.disposition, ["promoted", "rejected", "unchanged"] as const) ||
        !oneOf(receipt.checkScope, ["declared", "protected-declared"] as const) ||
        !oneOf(receipt.checkStatus, ["passed", "failed", "unverified"] as const)) return undefined;
    const checked = data(receipt.checks);
    const inputs = data(receipt.inputs);
    if (checked === undefined || !count(checked.total) || !count(checked.passed) || !count(checked.failed) || checked.passed + checked.failed > checked.total ||
        inputs === undefined || !count(inputs.declared) || !count(inputs.verified) || inputs.verified > inputs.declared ||
        (receipt.checkedPayloadDigest !== undefined && !digest(receipt.checkedPayloadDigest)) ||
        (receipt.checkPlanDigest !== undefined && !digest(receipt.checkPlanDigest)) ||
        (receipt.reason !== undefined && !oneOf(receipt.reason, REASONS))) return undefined;
    if ((receipt.checkStatus === "passed" && (checked.total === 0 || checked.passed !== checked.total || checked.failed !== 0)) ||
        (receipt.checkStatus === "failed" && checked.failed === 0) ||
        (receipt.checkScope === "protected-declared" && (inputs.declared === 0 || inputs.verified !== inputs.declared)) ||
        (receipt.disposition !== "rejected" && (receipt.checkStatus !== "passed" || inputs.declared !== inputs.verified ||
          !digest(receipt.checkedPayloadDigest) || !digest(receipt.checkPlanDigest) || receipt.reason !== undefined))) return undefined;
    return {
      version: 1, id: receipt.id, disposition: receipt.disposition, checkScope: receipt.checkScope, checkStatus: receipt.checkStatus,
      checks: { total: checked.total, passed: checked.passed, failed: checked.failed },
      inputs: { declared: inputs.declared, verified: inputs.verified },
      ...(receipt.checkedPayloadDigest === undefined ? {} : { checkedPayloadDigest: receipt.checkedPayloadDigest as string }),
      ...(receipt.checkPlanDigest === undefined ? {} : { checkPlanDigest: receipt.checkPlanDigest as string }),
      ...(receipt.reason === undefined ? {} : { reason: receipt.reason as CandidateRejectionReason }),
    };
  } catch {
    // Proxies and other runtime objects can throw on reflection. They provide no evidence.
    return undefined;
  }
}
