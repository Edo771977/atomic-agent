import { posix, win32 } from "node:path";
import type { CompressedToolResult } from "../../compressor/result-compressor.js";
import { knownSecretsFromEnv, maskSecrets } from "../../error-reporting/secret-detector.js";
import { parseArtifactManifest } from "./artifact-manifest.js";
import type { ArtifactManifest } from "./artifact-manifest-types.js";

export const ARTIFACT_EVIDENCE_OUTPUT_MAX_CHARS = 4_000;
const PREFIX = "artifact-evidence: ";
const TASKS = 16;
const FACTS = 8;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const safeName = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(value) && maskSecrets(value, knownSecretsFromEnv()) === value;
const safePath = (value: string | null): value is string => value !== null && value.length <= 256 && !posix.isAbsolute(value) &&
  !win32.isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value) && !value.split(/[\\/]/).includes("..") && maskSecrets(value, knownSecretsFromEnv()) === value;

function projectReceipt(value: unknown): Record<string, unknown> | undefined {
  const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 100_000;
  const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  if (!record(value) || value.version !== 1 || typeof value.id !== "string" || !/^[a-f0-9]{24}$/.test(value.id) ||
      !["promoted", "rejected", "unchanged"].includes(String(value.disposition)) || !["declared", "protected-declared"].includes(String(value.checkScope)) ||
      !["passed", "failed", "unverified"].includes(String(value.checkStatus)) || !record(value.checks) || !record(value.inputs) ||
      !count(value.checks.total) || !count(value.checks.passed) || !count(value.checks.failed) || value.checks.passed + value.checks.failed > value.checks.total ||
      !count(value.inputs.declared) || !count(value.inputs.verified) || value.inputs.verified > value.inputs.declared ||
      (value.checkedPayloadDigest !== undefined && !digest(value.checkedPayloadDigest)) || (value.checkPlanDigest !== undefined && !digest(value.checkPlanDigest)) ||
      (value.disposition !== "rejected" && (value.checkStatus !== "passed" || value.checks.total === 0 || value.checks.passed !== value.checks.total || value.checks.failed !== 0 ||
        !digest(value.checkedPayloadDigest) || !digest(value.checkPlanDigest)))) return undefined;
  const reasons = ["checks-failed", "checks-unverified", "check-inputs-changed", "payload-changed", "provides-unverified", "task-not-ok", "original-changed", "delivery-failed", "interrupted", "other"];
  return { version: 1, id: value.id, disposition: value.disposition, checkScope: value.checkScope, checkStatus: value.checkStatus,
    checks: { total: value.checks.total, passed: value.checks.passed, failed: value.checks.failed }, inputs: { declared: value.inputs.declared, verified: value.inputs.verified },
    ...(value.checkedPayloadDigest === undefined ? {} : { checkedPayloadDigest: value.checkedPayloadDigest }),
    ...(value.checkPlanDigest === undefined ? {} : { checkPlanDigest: value.checkPlanDigest }), ...(reasons.includes(String(value.reason)) ? { reason: value.reason } : {}) };
}

function projectManifest(manifest: ArtifactManifest, candidate: boolean): Record<string, unknown> {
  // Task inventories precede final acceptance. Even a saved binding cannot
  // turn one into the candidate's final delivery proof.
  const binding = candidate && manifest.coverage.source === "snapshot" ? manifest.binding : undefined;
  const artifacts = manifest.artifacts.filter(e => safePath(e.path)).slice(0, FACTS).map(e => ({ path: e.path, kind: e.kind, state: e.state,
    ...(e.sha256 === undefined ? {} : { sha256: e.sha256 }), ...(e.bytes === undefined ? {} : { bytes: e.bytes }) }));
  const checks = manifest.checks.slice(0, FACTS).map(c => ({ id: c.id, source: c.source, status: c.status }));
  const dependencies = manifest.dependencies.filter(d => safeName(d.provider)).slice(0, FACTS).map(d => ({ ...d }));
  const omitted = manifest.omitted + manifest.artifacts.length + manifest.checks.length + manifest.dependencies.length - artifacts.length - checks.length - dependencies.length;
  const reasons = new Set(manifest.coverage.reasons);
  if (omitted > 0) reasons.add("metadata_truncated");
  if (!candidate) reasons.add("observed_scope");
  return {
    ...(binding?.scope === "candidate-snapshot" ? binding : { scope: candidate ? "candidate-snapshot" : "final-project-observation", disposition: "observed" }),
    coverage: { complete: candidate && manifest.coverage.complete && omitted === 0, reasons: [...reasons] }, artifacts, checks, dependencies, omitted,
  };
}

/**
 * Final output adapter: call after compression/candidate wrapping. The first
 * line is a whole bounded JSON document; worker prose only follows it. Both
 * local summaries and cloud full-output promotion receive the same receipt.
 */
export function projectFusionArtifactEvidence(result: CompressedToolResult, maxChars: number): CompressedToolResult {
  const rows = Array.isArray(result.details.tasks) ? result.details.tasks : [];
  const tasks: Record<string, unknown>[] = [];
  let omitted = 0;
  for (const row of rows.slice(0, TASKS)) {
    if (!record(row) || row.artifactManifest === undefined) continue;
    const manifest = parseArtifactManifest(row.artifactManifest);
    if (manifest === undefined || !safeName(row.id)) { omitted += 1; continue; }
    const status = typeof row.status === "string" && ["ok", "failed", "cancelled", "timeout", "queued", "max_steps", "needs_orchestrator", "no_changes"].includes(row.status) ? row.status : "unknown";
    const projected = projectManifest(manifest, false);
    tasks.push({ id: row.id, status, ...projected });
    omitted += projected.omitted as number;
  }
  omitted += Math.max(0, rows.length - TASKS);
  const report = record(result.details.candidateIntegration) ? result.details.candidateIntegration : undefined;
  const manifest = report?.artifactManifest === undefined ? undefined : parseArtifactManifest(report.artifactManifest);
  const receipt = projectReceipt(report?.acceptanceReceipt);
  if (report?.acceptanceReceipt !== undefined && receipt === undefined) omitted += 1;
  const candidate = manifest === undefined && receipt === undefined ? undefined : {
    ...(manifest === undefined ? {} : projectManifest(manifest, true)), ...(receipt === undefined ? {} : { receipt }),
  };
  const candidateOmitted = candidate === undefined ? undefined : (candidate as Record<string, unknown>).omitted;
  if (typeof candidateOmitted === "number") omitted += candidateOmitted;
  if (candidate === undefined && tasks.length === 0 && omitted === 0) return result;
  const cap = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : ARTIFACT_EVIDENCE_OUTPUT_MAX_CHARS;
  if (cap < 2) {
    const out = { ...result, summary: "", truncated: true };
    Object.defineProperty(out, "fullOutput", { value: "", enumerable: false });
    Object.defineProperty(out, "fullOutputTruncated", { value: true, enumerable: false });
    return out;
  }
  const budget = Math.min(ARTIFACT_EVIDENCE_OUTPUT_MAX_CHARS, Math.max(2, cap - PREFIX.length));
  const value: { version: 1; tasks: Record<string, unknown>[]; candidate?: Record<string, unknown>; omitted: number } = {
    version: 1, tasks, ...(candidate === undefined ? {} : { candidate }), omitted,
  };
  const serialize = () => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  // Remove whole fields/entries, never slice JSON. Candidate acceptance takes
  // precedence over task observations; truncation is counted explicitly.
  while (serialize().length > budget) {
    const entries = [...value.tasks, ...(value.candidate === undefined ? [] : [value.candidate])];
    const entry = entries.find(e => ["artifacts", "dependencies", "checks"].some(key => Array.isArray(e[key]) && (e[key] as unknown[]).length > 0));
    if (entry !== undefined) {
      const key = ["artifacts", "dependencies", "checks"].find(k => Array.isArray(entry[k]) && (entry[k] as unknown[]).length > 0)!;
      (entry[key] as unknown[]).pop(); value.omitted += 1;
      if (typeof entry.omitted === "number") entry.omitted += 1;
      const coverage = entry.coverage;
      if (record(coverage)) { coverage.complete = false; const reasons = coverage.reasons as string[]; if (!reasons.includes("metadata_truncated")) reasons.push("metadata_truncated"); }
    } else if (value.tasks.length > 0) { value.tasks.pop(); value.omitted += 1; }
    else if (value.candidate !== undefined) { delete value.candidate; value.omitted += 1; }
    else break;
  }
  const json = serialize();
  const head = json.length <= budget ? `${PREFIX}${json}` : cap >= PREFIX.length + 2 ? `${PREFIX}{}` : "{}";
  const output = (text: string) => `${head}${text.length > 0 && cap > head.length + 1 ? `\n${text.slice(0, cap - head.length - 1)}` : ""}`;
  const summary = output(result.summary);
  const out = { ...result, summary, truncated: result.truncated || summary.length < head.length + result.summary.length + 1 || value.omitted > 0 };
  Object.defineProperty(out, "fullOutput", { value: output(result.fullOutput ?? result.summary), enumerable: false });
  Object.defineProperty(out, "fullOutputTruncated", { value: out.truncated, enumerable: false });
  return out;
}
