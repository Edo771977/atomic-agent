import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { isInside } from "../../approval/fanout-scope.js";
import type { CandidateAcceptanceReceipt } from "./candidate-acceptance.js";
import type {
  ArtifactManifest, ArtifactManifestEntry, ArtifactManifestReason,
  ArtifactManifestBinding, CollectArtifactManifestInput,
} from "./artifact-manifest-types.js";

export type * from "./artifact-manifest-types.js";
export const ARTIFACT_MANIFEST_MAX_ENTRIES = 128;
export const ARTIFACT_MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
export const ARTIFACT_MANIFEST_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const ARTIFACT_MANIFEST_MAX_JSON_BYTES = 128 * 1024;
const MAX_PATH = 4_096;
const MAX_DURATION_MS = 2_000;
const ABORTED = Symbol("artifact-manifest-aborted");

function ceiling(value: number | undefined, max: number): number {
  return value === undefined || !Number.isFinite(value) ? max : Math.max(0, Math.min(max, Math.floor(value)));
}

function empty(input: Pick<CollectArtifactManifestInput, "coverage" | "incomplete">): ArtifactManifest {
  return { version: 1, coverage: { source: input.coverage ?? "observed", complete: false,
    reasons: [...new Set([...(input.coverage === "snapshot" ? [] : ["observed_scope" as const]), ...(input.incomplete ?? [])])] },
    artifacts: [], checks: [], dependencies: [], bytesHashed: 0, omitted: 0,
    ...(input.coverage === "snapshot" ? {} : { binding: { scope: "final-project-observation", disposition: "observed" } }) };
}

function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw ABORTED;
  return new Promise<T>((accept, reject) => {
    const stopped = () => reject(ABORTED);
    signal.addEventListener("abort", stopped, { once: true });
    pending.then(value => { signal.removeEventListener("abort", stopped); accept(value); },
      error => { signal.removeEventListener("abort", stopped); reject(error); });
  });
}

/** Hash a bounded runtime inventory. Snapshot authority must come from the caller, never a worker reply. */
export async function collectArtifactManifest(input: CollectArtifactManifestInput): Promise<ArtifactManifest> {
  const manifest = empty(input);
  const reasons = new Set(manifest.coverage.reasons);
  const add = (reason: ArtifactManifestReason) => { reasons.add(reason); };
  const cap = ceiling(input.limits?.entries, ARTIFACT_MANIFEST_MAX_ENTRIES);
  const bytes = ceiling(input.limits?.bytes, ARTIFACT_MANIFEST_MAX_BYTES);
  const fileBytes = ceiling(input.limits?.fileBytes, ARTIFACT_MANIFEST_MAX_FILE_BYTES);
  const deadline = new AbortController();
  const duration = ceiling(input.limits?.durationMs, MAX_DURATION_MS);
  if (duration === 0) deadline.abort();
  const timer = setTimeout(() => deadline.abort(), duration);
  timer.unref?.();
  const signal = AbortSignal.any([input.signal, deadline.signal]);
  const workingDir = resolve(input.workingDir);
  const roots = input.roots.map(root => resolve(root));
  const realRoots = signal.aborted ? roots : await abortable(Promise.all(roots.map(root => realpath(root).catch(() => root))), signal).catch(() => roots);
  const seen = new Set<string>();
  try {
    for (let index = 0; index < input.artifacts.length; index += 1) {
      const observation = input.artifacts[index]!;
      if (signal.aborted) { add("aborted"); manifest.omitted += input.artifacts.length - index; break; }
      if (manifest.artifacts.length >= cap || index >= ARTIFACT_MANIFEST_MAX_ENTRIES * 4) {
        add("entry_limit"); manifest.omitted += input.artifacts.length - index; break;
      }
      if (observation.path.length > MAX_PATH) { add("path_limit"); manifest.omitted += 1; continue; }
      const absolute = resolve(workingDir, observation.path);
      const rel = relative(workingDir, absolute);
      const path = isAbsolute(rel) ? null : (rel || ".").split(sep).join("/");
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      if (path !== null && path.length > MAX_PATH) { add("path_limit"); manifest.omitted += 1; continue; }
      const entry: ArtifactManifestEntry = { path, change: observation.change, source: observation.source, kind: "unknown", state: "unreadable" };
      manifest.artifacts.push(entry);
      if (path === null || !roots.some(root => isInside(root, absolute))) {
        entry.state = "outside_scope"; add("outside_scope"); continue;
      }
      try {
        const parent = await abortable(realpath(dirname(absolute)), signal);
        if (!realRoots.some(root => isInside(root, parent)) && !roots.includes(absolute)) {
          entry.state = "outside_scope"; add("outside_scope"); continue;
        }
        const info = await abortable(lstat(absolute, { bigint: true }), signal);
        // Resolve the parent for links, never the link's target. A link in an
        // outside parent is outside scope even when lexically under a root.
        const actual = info.isSymbolicLink()
          ? resolve(parent, basename(absolute))
          : await abortable(realpath(absolute), signal);
        if (!realRoots.some(root => isInside(root, actual)) && !roots.some(root => root === absolute && info.isSymbolicLink())) {
          entry.state = "outside_scope"; add("outside_scope"); continue;
        }
        entry.mode = Number(info.mode);
        if (observation.source === "snapshot" && observation.change === "deleted") {
          entry.state = "changed"; add("changed_during_read"); continue;
        }
        if (info.isSymbolicLink()) {
          entry.kind = "symlink";
          const target = await abortable(readlink(absolute, { encoding: "buffer" }), signal);
          if (target.length > fileBytes || target.length > bytes - manifest.bytesHashed) {
            entry.state = "too_large"; add(target.length > fileBytes ? "file_limit" : "byte_limit"); continue;
          }
          const after = await abortable(lstat(absolute, { bigint: true }), signal);
          if (!same(info, after)) { entry.state = "changed"; add("changed_during_read"); continue; }
          entry.sha256 = createHash("sha256").update(target).digest("hex");
          entry.bytes = target.length; manifest.bytesHashed += target.length; entry.state = "hashed";
        } else if (info.isDirectory()) {
          entry.kind = "directory"; entry.state = "metadata";
        } else if (info.isFile()) {
          entry.kind = "file";
          if (info.size > BigInt(fileBytes) || info.size > BigInt(bytes - manifest.bytesHashed)) {
            entry.state = "too_large"; add(info.size > BigInt(fileBytes) ? "file_limit" : "byte_limit"); continue;
          }
          const pending = open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          let handle;
          try { handle = await abortable(pending, signal); }
          catch (error) { void pending.then(h => h.close(), () => {}); throw error; }
          try {
            if (!same(info, await abortable(handle.stat({ bigint: true }), signal))) {
              entry.state = "changed"; add("changed_during_read"); continue;
            }
            const hash = createHash("sha256");
            const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, Number(info.size))));
            let position = 0;
            while (position < Number(info.size)) {
              const read = await abortable(handle.read(buffer, 0, Math.min(buffer.length, Number(info.size) - position), position), signal);
              if (read.bytesRead === 0) break;
              hash.update(buffer.subarray(0, read.bytesRead));
              position += read.bytesRead; manifest.bytesHashed += read.bytesRead;
            }
            const after = await abortable(handle.stat({ bigint: true }), signal);
            const pathAfter = await abortable(lstat(absolute, { bigint: true }), signal);
            if (position !== Number(info.size) || !same(info, after) || !same(info, pathAfter)) {
              entry.state = "changed"; add("changed_during_read"); continue;
            }
            entry.sha256 = hash.digest("hex"); entry.bytes = position; entry.state = "hashed";
          } finally {
            if (signal.aborted) void handle.close().catch(() => {});
            else await handle.close();
          }
        } else { add("unsupported_kind"); }
      } catch (error) {
        if (error === ABORTED || signal.aborted) { entry.state = "aborted"; add("aborted"); }
        else {
          // Keep only the error class, never a path-bearing error message.
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") {
            entry.kind = observation.change === "deleted" ? "deleted" : "missing"; entry.state = "missing";
            if (entry.kind === "missing") add("missing_artifact");
          } else { entry.state = "unreadable"; add("unreadable"); }
        }
      }
    }
    manifest.checks = (input.checks ?? []).slice(0, 64).map(check => ({ id: check.id, source: check.source, status: check.status }));
    manifest.dependencies = (input.dependencies ?? []).slice(0, 128).map(dependency => ({ provider: dependency.provider, requirementIndex: dependency.requirementIndex, status: dependency.status }));
    if ((input.checks?.length ?? 0) > 64 || (input.dependencies?.length ?? 0) > 128) add("metadata_truncated");
    if (manifest.checks.some(c => c.status === "unknown") || manifest.dependencies.some(d => d.status === "unknown")) add("verification_unknown");
    if (signal.aborted) add("aborted");
    manifest.coverage.reasons = [...reasons];
    manifest.coverage.complete = manifest.coverage.source === "snapshot" && reasons.size === 0;
    return boundArtifactManifest(parseArtifactManifest(boundArtifactManifest(manifest)) ?? incompleteArtifactManifest());
  } finally { clearTimeout(timer); }
}

/** Apply the same evidence-size boundary before result emission and checkpoint serialization. */
export function boundArtifactManifest(manifest: ArtifactManifest): ArtifactManifest {
  const out: ArtifactManifest = structuredClone(manifest);
  let clipped = false;
  for (const key of ["artifacts", "checks", "dependencies"] as const) {
    const limit = key === "checks" ? 64 : 128;
    if (out[key].length > limit) { out.omitted += out[key].length - limit; out[key].splice(limit); clipped = true; }
  }
  if (!out.coverage.reasons.includes("metadata_truncated") &&
      Buffer.byteLength(JSON.stringify(out), "utf8") > ARTIFACT_MANIFEST_MAX_JSON_BYTES) {
    out.coverage.reasons.push("metadata_truncated"); out.coverage.complete = false;
  }
  while (Buffer.byteLength(JSON.stringify(out), "utf8") > ARTIFACT_MANIFEST_MAX_JSON_BYTES) {
    if (out.artifacts.length > 0) { out.artifacts.pop(); out.omitted += 1; }
    else if (out.dependencies.length > 0) { out.dependencies.pop(); out.omitted += 1; }
    else if (out.checks.length > 0) { out.checks.pop(); out.omitted += 1; }
    else break;
    clipped = true;
  }
  if (clipped) {
    out.coverage.complete = false;
    if (!out.coverage.reasons.includes("metadata_truncated")) out.coverage.reasons.push("metadata_truncated");
  }
  return out;
}

const REASONS: readonly ArtifactManifestReason[] = ["observed_scope", "untracked_writes", "entry_limit", "byte_limit", "file_limit", "path_limit", "outside_scope", "unreadable", "changed_during_read", "aborted", "metadata_truncated", "verification_unknown", "unsupported_kind", "missing_artifact"];
const CHANGES = ["new", "modified", "deleted", "observed", "restored", "mode"];
const SOURCES = ["file-tool", "declared", "provide", "snapshot"];
const KINDS = ["file", "symlink", "directory", "deleted", "missing", "unknown"];
const STATES = ["hashed", "metadata", "missing", "outside_scope", "unreadable", "too_large", "changed", "aborted"];
const STATUSES = ["pass", "fail", "unknown"];
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const number = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const member = (values: readonly string[], value: unknown): boolean => typeof value === "string" && values.includes(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function parseBinding(value: unknown, source: unknown): ArtifactManifestBinding | undefined {
  if (!record(value)) return undefined;
  if (value.scope === "final-project-observation") return source === "observed" && value.disposition === "observed" &&
    value.receiptId === undefined && value.checkStatus === undefined && value.checkedPayloadDigest === undefined && value.checkPlanDigest === undefined
    ? { scope: "final-project-observation", disposition: "observed" } : undefined;
  if (value.scope !== "candidate-snapshot" || source !== "snapshot" || typeof value.receiptId !== "string" || !/^[a-f0-9]{24}$/.test(value.receiptId) ||
      !member(["promoted", "rejected", "unchanged"], value.disposition) || !member(["declared", "protected-declared"], value.checkScope) ||
      !member(["passed", "failed", "unverified"], value.checkStatus) ||
      (value.checkedPayloadDigest !== undefined && !digest(value.checkedPayloadDigest)) ||
      (value.checkPlanDigest !== undefined && !digest(value.checkPlanDigest)) ||
      (value.disposition !== "rejected" && (value.checkStatus !== "passed" || !digest(value.checkedPayloadDigest) || !digest(value.checkPlanDigest)))) return undefined;
  return { scope: "candidate-snapshot", receiptId: value.receiptId, disposition: value.disposition as "promoted" | "rejected" | "unchanged",
    checkScope: value.checkScope as "declared" | "protected-declared", checkStatus: value.checkStatus as "passed" | "failed" | "unverified",
    ...(value.checkedPayloadDigest === undefined ? {} : { checkedPayloadDigest: value.checkedPayloadDigest }),
    ...(value.checkPlanDigest === undefined ? {} : { checkPlanDigest: value.checkPlanDigest }) };
}

/** Structural subset of the neutral candidate receipt; no outcome or candidate dependency. */
export type CandidateArtifactReceipt = Pick<CandidateAcceptanceReceipt,
  "version" | "id" | "disposition" | "checkScope" | "checkStatus" | "checkedPayloadDigest" | "checkPlanDigest">;

/** Only final authoritative candidate inventory may carry final delivery proof. */
export function attachCandidateArtifactReceipt(manifest: ArtifactManifest, receipt: CandidateArtifactReceipt): ArtifactManifest {
  const clean = parseArtifactManifest(manifest) ?? incompleteArtifactManifest();
  if (clean.coverage.source !== "snapshot" || receipt.version !== 1) return clean;
  const binding = parseBinding({ scope: "candidate-snapshot", receiptId: receipt.id, disposition: receipt.disposition,
    checkScope: receipt.checkScope, checkStatus: receipt.checkStatus, checkedPayloadDigest: receipt.checkedPayloadDigest, checkPlanDigest: receipt.checkPlanDigest }, "snapshot");
  return binding === undefined ? clean : boundArtifactManifest({ ...clean, binding });
}

/** Strict, whitelist-only v1 persistence boundary; extra contents/args/output fields are never copied. */
export function parseArtifactManifest(value: unknown): ArtifactManifest | undefined {
  try {
    if (!record(value) || value.version !== 1 || !record(value.coverage) ||
        !member(["observed", "snapshot"], value.coverage.source) || typeof value.coverage.complete !== "boolean" ||
        !Array.isArray(value.coverage.reasons) || !value.coverage.reasons.every(r => member(REASONS, r)) ||
        !number(value.bytesHashed) || value.bytesHashed > ARTIFACT_MANIFEST_MAX_BYTES || !number(value.omitted) ||
        !Array.isArray(value.artifacts) || value.artifacts.length > 128 ||
        !Array.isArray(value.checks) || value.checks.length > 64 ||
        !Array.isArray(value.dependencies) || value.dependencies.length > 128 ||
        Buffer.byteLength(JSON.stringify(value), "utf8") > ARTIFACT_MANIFEST_MAX_JSON_BYTES) return undefined;
    const binding = value.binding === undefined ? undefined : parseBinding(value.binding, value.coverage.source);
    if (value.binding !== undefined && binding === undefined) return undefined;
    const artifacts: ArtifactManifestEntry[] = [];
    for (const e of value.artifacts) {
      if (!record(e) || !(e.path === null || (typeof e.path === "string" && e.path.length > 0 && e.path.length <= MAX_PATH &&
          !posix.isAbsolute(e.path) && !win32.isAbsolute(e.path) && posix.normalize(e.path) === e.path)) ||
          !member(CHANGES, e.change) || !member(SOURCES, e.source) || !member(KINDS, e.kind) || !member(STATES, e.state) ||
          (e.mode !== undefined && (!number(e.mode) || e.mode > 0xffffffff)) ||
          (e.bytes !== undefined && (!number(e.bytes) || e.bytes > ARTIFACT_MANIFEST_MAX_FILE_BYTES)) ||
          (e.sha256 !== undefined && (typeof e.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(e.sha256))) ||
          (e.path === null && e.state !== "outside_scope") ||
          (e.state === "outside_scope" && e.kind !== "unknown") ||
          (e.state === "metadata" && e.kind !== "directory") ||
          (e.state === "missing" && !member(["deleted", "missing"], e.kind)) ||
          (e.state === "hashed" && (!member(["file", "symlink"], e.kind) || e.sha256 === undefined || e.bytes === undefined)) ||
          (e.state !== "hashed" && e.sha256 !== undefined)) return undefined;
      artifacts.push({ path: e.path, change: e.change, source: e.source, kind: e.kind, state: e.state,
        ...(e.mode === undefined ? {} : { mode: e.mode }), ...(e.bytes === undefined ? {} : { bytes: e.bytes }),
        ...(e.sha256 === undefined ? {} : { sha256: e.sha256 }) } as ArtifactManifestEntry);
    }
    const checks: ArtifactManifest["checks"] = [];
    for (const c of value.checks) {
      if (!record(c) || typeof c.id !== "string" || !/^[a-z][a-z0-9_-]{0,31}:\d+$/.test(c.id) ||
          !member(["contract", "syntax"], c.source) || !member(STATUSES, c.status)) return undefined;
      checks.push({ id: c.id, source: c.source, status: c.status } as ArtifactManifest["checks"][number]);
    }
    const dependencies: ArtifactManifest["dependencies"] = [];
    for (const d of value.dependencies) {
      if (!record(d) || typeof d.provider !== "string" || d.provider.length > MAX_PATH ||
          !number(d.requirementIndex) || !member(["ready", "blocked", "unknown"], d.status)) return undefined;
      dependencies.push({ provider: d.provider, requirementIndex: d.requirementIndex, status: d.status } as ArtifactManifest["dependencies"][number]);
    }
    if (artifacts.reduce((n, e) => n + (e.bytes ?? 0), 0) > value.bytesHashed) return undefined;
    const reasons = new Set(value.coverage.reasons as ArtifactManifestReason[]);
    if (value.coverage.source === "observed") reasons.add("observed_scope");
    if (value.omitted > 0) reasons.add("metadata_truncated");
    if (checks.some(c => c.status === "unknown") || dependencies.some(d => d.status === "unknown")) reasons.add("verification_unknown");
    for (const e of artifacts) {
      if (e.state === "outside_scope") reasons.add("outside_scope");
      if (e.state === "unreadable") reasons.add("unreadable");
      if (e.state === "changed") reasons.add("changed_during_read");
      if (e.state === "aborted") reasons.add("aborted");
      if (e.state === "too_large") reasons.add("file_limit");
      if (e.kind === "missing") reasons.add("missing_artifact");
    }
    return { version: 1, coverage: { source: value.coverage.source as "observed" | "snapshot", complete: value.coverage.complete && reasons.size === 0, reasons: [...reasons] }, artifacts, checks, dependencies, bytesHashed: value.bytesHashed, omitted: value.omitted, ...(binding === undefined ? {} : { binding }) };
  } catch { return undefined; }
}

export function incompleteArtifactManifest(manifest?: ArtifactManifest): ArtifactManifest {
  return { ...(manifest ?? empty({})), artifacts: [], checks: [], dependencies: [], coverage: {
    source: manifest?.coverage.source ?? "observed", complete: false,
    reasons: [...new Set([...(manifest?.coverage.reasons ?? ["observed_scope" as const]), "metadata_truncated" as const])],
  }, omitted: (manifest?.omitted ?? 0) + (manifest?.artifacts.length ?? 0) + (manifest?.checks.length ?? 0) + (manifest?.dependencies.length ?? 0) };
}

export function storedArtifactManifest(value: unknown): ArtifactManifest {
  const parsed = parseArtifactManifest(value);
  if (parsed !== undefined) return parsed;
  try { return parseArtifactManifest(boundArtifactManifest(value as ArtifactManifest)) ?? incompleteArtifactManifest(); }
  catch { return incompleteArtifactManifest(); }
}
