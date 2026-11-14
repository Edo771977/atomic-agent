import { posix, win32 } from "node:path";
import type { CompressedToolResult } from "../../compressor/result-compressor.js";
import { knownSecretsFromEnv, maskSecrets, type KnownSecret } from "../../error-reporting/secret-detector.js";
import { parseArtifactManifest } from "./artifact-manifest.js";
import type { ArtifactManifest } from "./artifact-manifest-types.js";
import type { CandidateAcceptanceReceipt } from "./candidate-acceptance.js";
import { parseCandidateAcceptanceReceipt } from "./candidate-receipt.js";

export const ARTIFACT_EVIDENCE_OUTPUT_MAX_CHARS = 4_000;
const PREFIX = "artifact-evidence: ";
const TASKS = 16;
const FACTS = 8;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const safeText = (value: string, known: readonly KnownSecret[]): boolean => maskSecrets(value, known) === value;
const safeName = (value: unknown, known: readonly KnownSecret[]): value is string => typeof value === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(value) && safeText(value, known);
const safePath = (value: string | null, known: readonly KnownSecret[]): value is string => value !== null && value.length <= 256 && !posix.isAbsolute(value) &&
  !win32.isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value) && !value.split(/[\\/]/).includes("..") && safeText(value, known);

export interface ArtifactEvidenceOutputOptions { knownSecrets?: readonly KnownSecret[] }

/** A pathological secret label must not make a later registry mask grow this output again. */
function maskedSource(text: string, known: readonly KnownSecret[]): string {
  let current = text;
  for (let i = 0; i < 3; i += 1) {
    const next = maskSecrets(current, known);
    if (next === current) return current;
    current = next;
  }
  return "";
}

/** Keep a redaction marker whole when a prose budget lands inside it. */
function clipMasked(text: string, limit: number): string {
  let end = Math.max(0, limit);
  if (end >= text.length) return text;
  const marker = text.lastIndexOf("[redacted:", end);
  if (marker >= 0 && text.indexOf("]", marker) >= end) end = marker;
  return text.slice(0, end);
}

function withOutput(result: CompressedToolResult, summary: string, fullOutput: string, truncated: boolean): CompressedToolResult {
  const out = { ...result, summary, truncated };
  Object.defineProperty(out, "fullOutput", { value: fullOutput, enumerable: false });
  Object.defineProperty(out, "fullOutputTruncated", { value: truncated, enumerable: false });
  return out;
}

function projectManifest(manifest: ArtifactManifest, candidate: boolean, known: readonly KnownSecret[], receipt?: CandidateAcceptanceReceipt): Record<string, unknown> {
  // Task inventories precede final acceptance. Even a saved binding cannot
  // turn one into the candidate's final delivery proof.
  const view = manifest.binding;
  const binding = candidate && manifest.coverage.source === "snapshot" && view?.scope === "candidate-snapshot" && receipt !== undefined &&
    view.receiptId === receipt.id && view.disposition === receipt.disposition && view.checkScope === receipt.checkScope && view.checkStatus === receipt.checkStatus &&
    view.checkedPayloadDigest === receipt.checkedPayloadDigest && view.checkPlanDigest === receipt.checkPlanDigest ? view : undefined;
  const artifacts = manifest.artifacts.filter(e => safePath(e.path, known) && (e.sha256 === undefined || safeText(e.sha256, known))).slice(0, FACTS).map(e => ({ path: e.path, kind: e.kind, state: e.state,
    ...(e.sha256 === undefined ? {} : { sha256: e.sha256 }), ...(e.bytes === undefined ? {} : { bytes: e.bytes }) }));
  const checks = manifest.checks.filter(c => safeText(c.id, known)).slice(0, FACTS).map(c => ({ id: c.id, source: c.source, status: c.status }));
  const dependencies = manifest.dependencies.filter(d => safeName(d.provider, known)).slice(0, FACTS).map(d => ({ ...d }));
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
export function projectFusionArtifactEvidence(result: CompressedToolResult, maxChars: number, options: ArtifactEvidenceOutputOptions = {}): CompressedToolResult {
  const known = [...(options.knownSecrets ?? []), ...knownSecretsFromEnv()];
  // The compressor's summary can already end in a partial config-only key.
  // Recover from the retained whole source, mask it before cutting, and use
  // the same safe source for both local and cloud output.
  const summarySource = maskedSource(result.summary, known);
  const source = result.fullOutput === undefined ? summarySource : maskedSource(result.fullOutput, known);
  const cap = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : ARTIFACT_EVIDENCE_OUTPUT_MAX_CHARS;
  const rows = Array.isArray(result.details.tasks) ? result.details.tasks : [];
  const tasks: Record<string, unknown>[] = [];
  let omitted = 0;
  for (const row of rows.slice(0, TASKS)) {
    if (!record(row) || row.artifactManifest === undefined) continue;
    const manifest = parseArtifactManifest(row.artifactManifest);
    if (manifest === undefined || !safeName(row.id, known)) { omitted += 1; continue; }
    const status = typeof row.status === "string" && ["ok", "failed", "cancelled", "timeout", "queued", "max_steps", "needs_orchestrator", "no_changes"].includes(row.status) ? row.status : "unknown";
    const projected = projectManifest(manifest, false, known);
    tasks.push({ id: row.id, status, ...projected });
    omitted += projected.omitted as number;
  }
  omitted += Math.max(0, rows.length - TASKS);
  const report = record(result.details.candidateIntegration) ? result.details.candidateIntegration : undefined;
  const manifest = report?.artifactManifest === undefined ? undefined : parseArtifactManifest(report.artifactManifest);
  if (report?.artifactManifest !== undefined && manifest === undefined) omitted += 1;
  const parsedReceipt = parseCandidateAcceptanceReceipt(report?.acceptanceReceipt);
  const receipt = parsedReceipt !== undefined && safeText(JSON.stringify(parsedReceipt), known) ? parsedReceipt : undefined;
  if (report?.acceptanceReceipt !== undefined && receipt === undefined) omitted += 1;
  const candidate = manifest === undefined && receipt === undefined ? undefined : {
    ...(manifest === undefined ? {} : projectManifest(manifest, true, known, receipt)), ...(receipt === undefined ? {} : { receipt }),
  };
  const candidateOmitted = candidate === undefined ? undefined : (candidate as Record<string, unknown>).omitted;
  if (typeof candidateOmitted === "number") omitted += candidateOmitted;
  if (candidate === undefined && tasks.length === 0 && omitted === 0) {
    const text = clipMasked(source, cap);
    const kept = safeText(text, known) ? text : "";
    return withOutput(result, kept, kept, result.truncated || kept.length < source.length);
  }
  if (cap < 2) {
    return withOutput(result, "", "", true);
  }
  const budget = Math.min(ARTIFACT_EVIDENCE_OUTPUT_MAX_CHARS, Math.max(2, cap - PREFIX.length));
  const value: { version: 1; tasks: Record<string, unknown>[]; candidate?: Record<string, unknown>; omitted: number } = {
    version: 1, tasks, ...(candidate === undefined ? {} : { candidate }), omitted,
  };
  let privacyOmitted = false;
  const serialize = () => {
    const json = JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
    if (safeText(json, known)) return json;
    // Fixed schema bytes can themselves coincide with a configured value.
    // Never mask across JSON syntax or publish a partially redacted identity.
    privacyOmitted = true;
    const minimal = JSON.stringify({ version: 1, tasks: [], omitted: Math.max(1, value.omitted) });
    return safeText(minimal, known) ? minimal : "{}";
  };
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
  let head = json.length <= budget ? `${PREFIX}${json}` : cap >= PREFIX.length + 2 ? `${PREFIX}{}` : "{}";
  if (!safeText(head, known)) { head = cap >= PREFIX.length + 2 && safeText(`${PREFIX}{}`, known) ? `${PREFIX}{}` : "{}"; privacyOmitted = true; }
  const prose = clipMasked(source, cap - head.length - 1);
  const joined = `${head}${prose.length > 0 ? `\n${prose}` : ""}`;
  // A cutoff can change a detector's boundary match. Keep just the stable
  // JSON rather than let a later mandatory mask expand the bounded result.
  const output = safeText(joined, known) ? joined : head;
  return withOutput(result, output, output, result.truncated || output.length < head.length + source.length + 1 || value.omitted > 0 || privacyOmitted);
}
