import { posix, win32 } from "node:path";
import type { CompressedToolResult } from "../../compressor/result-compressor.js";
import { knownSecretsFromEnv, maskSecrets, type KnownSecret } from "../../error-reporting/secret-detector.js";
import { parseArtifactManifest } from "./artifact-manifest.js";
import type { ArtifactManifest } from "./artifact-manifest-types.js";
import type { CandidateAcceptanceReceipt } from "./candidate-acceptance.js";
import { parseCandidateAcceptanceReceipt } from "./candidate-receipt.js";
import { frameUntrustedText } from "../untrusted-tool-output.js";
import { neutraliseControlMarkers } from "../control-marker-guard.js";

export const ARTIFACT_EVIDENCE_OUTPUT_MAX_CHARS = 4_000;
const PREFIX = "artifact-evidence: ";
const TASKS = 16;
const SCAN_ROWS = 256;
const FACTS = 8;
const PROSE_SOURCE = "Fusion worker reports";
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const safeText = (value: string, known: readonly KnownSecret[]): boolean => maskSecrets(value, known) === value;
const safeName = (value: unknown, known: readonly KnownSecret[]): value is string => typeof value === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(value) && safeText(value, known);
const safePath = (value: string | null, known: readonly KnownSecret[]): value is string => value !== null && value.length <= 256 && !posix.isAbsolute(value) &&
  !win32.isAbsolute(value) && !/[\p{Cc}\p{Cf}]/u.test(value) && !value.split(/[\\/]/).includes("..") && safeText(value, known);

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

/** Keep both nonce fences intact: clipping only ever applies to the untrusted body. */
function framedProse(source: string, budget: number): { text: string; truncated: boolean } {
  const visible = source.replace(/\r\n/g, "\n").replace(/[\p{Cc}\p{Cf}]/gu, char => char === "\n" || char === "\t" ? char : `\\u{${char.codePointAt(0)!.toString(16)}}`);
  const safe = neutraliseControlMarkers(visible).replace(/artifact-evidence[ \t]*:/gi, "untrusted-artifact-claim:");
  const overhead = frameUntrustedText("", PROSE_SOURCE).length;
  if (safe.length === 0 || budget <= overhead) return { text: "", truncated: safe.length > 0 };
  let body = clipMasked(safe, budget - overhead);
  let framed = frameUntrustedText(body, PROSE_SOURCE);
  // Marker neutralisation and a cutoff can alter a boundary match. Reframe
  // after reducing the body rather than cutting through the closing fence.
  while (framed.length > budget && body.length > 0) {
    body = clipMasked(body, body.length - (framed.length - budget));
    framed = frameUntrustedText(body, PROSE_SOURCE);
  }
  return { text: body.length > 0 && framed.length <= budget ? framed : "", truncated: body.length < safe.length };
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
  for (const row of rows.slice(0, SCAN_ROWS)) {
    if (!record(row) || row.artifactManifest === undefined) continue;
    const manifest = parseArtifactManifest(row.artifactManifest);
    if (manifest === undefined || !safeName(row.id, known)) { omitted += 1; continue; }
    if (tasks.length === TASKS) { omitted += 1; continue; }
    const status = typeof row.status === "string" && ["ok", "failed", "cancelled", "timeout", "queued", "max_steps", "needs_orchestrator", "no_changes"].includes(row.status) ? row.status : "unknown";
    const projected = projectManifest(manifest, false, known);
    tasks.push({ id: row.id, status, ...projected });
    omitted += projected.omitted as number;
  }
  omitted += Math.max(0, rows.length - SCAN_ROWS);
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
  if (cap < 2) {
    return withOutput(result, "", "", true);
  }
  const taskCounts: Record<string, number> = {};
  for (const row of rows.slice(0, SCAN_ROWS)) {
    const status = record(row) && typeof row.status === "string" && ["ok", "failed", "cancelled", "timeout", "queued", "max_steps", "needs_orchestrator", "no_changes"].includes(row.status) ? row.status : "unknown";
    taskCounts[status] = (taskCounts[status] ?? 0) + 1;
  }
  if (rows.length > SCAN_ROWS) taskCounts.unknown = (taskCounts.unknown ?? 0) + rows.length - SCAN_ROWS;
  const outcome = { status: result.status, ...(rows.length === 0 ? {} : { tasks: taskCounts }), ...(receipt === undefined ? {} : { candidateDisposition: receipt.disposition, checkStatus: receipt.checkStatus,
    ...(receipt.reason === undefined ? {} : { candidateReason: receipt.reason }) }) };
  const minimal = JSON.stringify({ version: 1, tasks: [], outcome, omitted });
  // Leave room for the outcome and readable prose on small local contexts.
  // Tiny caps may spend more than 40% on the minimal whole runtime document.
  const budget = Math.min(ARTIFACT_EVIDENCE_OUTPUT_MAX_CHARS, Math.max(2, cap - PREFIX.length), Math.max(minimal.length, Math.floor(cap * 0.4) - PREFIX.length));
  const value: { version: 1; tasks: Record<string, unknown>[]; candidate?: Record<string, unknown>; outcome: typeof outcome; omitted: number } = {
    version: 1, tasks, ...(candidate === undefined ? {} : { candidate }), outcome, omitted,
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
    else if (value.candidate !== undefined) {
      // The full validated receipt is more useful than duplicate inventory
      // binding/digest fields. Keep it while it fits; the compact outcome
      // still carries disposition/reason if the full receipt must be omitted.
      const full = value.candidate;
      if (Object.keys(full).some(key => !["scope", "disposition", "receipt"].includes(key))) {
        value.candidate = { ...(full.scope === undefined ? {} : { scope: full.scope }), ...(full.disposition === undefined ? {} : { disposition: full.disposition }),
          ...(full.receipt === undefined ? {} : { receipt: full.receipt }) }; value.omitted += 1;
      } else { delete value.candidate; value.omitted += 1; }
    }
    else break;
  }
  const json = serialize();
  let head = json.length <= budget ? `${PREFIX}${json}` : cap >= PREFIX.length + 2 ? `${PREFIX}{}` : "{}";
  if (!safeText(head, known)) { head = cap >= PREFIX.length + 2 && safeText(`${PREFIX}{}`, known) ? `${PREFIX}{}` : "{}"; privacyOmitted = true; }
  const prose = framedProse(source, cap - head.length - 1);
  const joined = `${head}${prose.text.length > 0 ? `\n${prose.text}` : ""}`;
  // A cutoff can change a detector's boundary match. Keep just the stable
  // JSON rather than let a later mandatory mask expand the bounded result.
  const output = safeText(joined, known) ? joined : head;
  return withOutput(result, output, output, result.truncated || prose.truncated || output !== joined || value.omitted > 0 || privacyOmitted);
}
