/** Runtime evidence only: no worker prose, file contents, command args or output. */
export type ArtifactSource = "file-tool" | "declared" | "provide" | "snapshot";
export type ArtifactChange = "new" | "modified" | "deleted" | "observed" | "restored" | "mode";
export type ArtifactManifestReason =
  | "observed_scope" | "untracked_writes" | "entry_limit" | "byte_limit" | "file_limit"
  | "path_limit" | "outside_scope" | "unreadable" | "changed_during_read" | "aborted"
  | "metadata_truncated" | "verification_unknown" | "unsupported_kind" | "missing_artifact";

export interface ArtifactObservation {
  path: string;
  change: ArtifactChange;
  source: ArtifactSource;
}

export interface ArtifactManifestEntry {
  /** Canonical lexical path relative to workingDir, with / separators; never absolute. */
  path: string | null;
  change: ArtifactChange;
  source: ArtifactSource;
  kind: "file" | "symlink" | "directory" | "deleted" | "missing" | "unknown";
  state: "hashed" | "metadata" | "missing" | "outside_scope" | "unreadable" | "too_large" | "changed" | "aborted";
  /** File bytes, or the symlink's link text; link targets are never followed. */
  sha256?: string;
  bytes?: number;
  /** Actual permission/type mode bits from lstat/fstat, without file contents. */
  mode?: number;
}

export interface ArtifactManifestCheck {
  /** Runtime-assigned identifier, not a command or user-supplied check description. */
  id: string;
  source: "contract" | "syntax";
  status: "pass" | "fail" | "unknown";
}

export interface ArtifactManifestDependency {
  provider: string;
  requirementIndex: number;
  status: "ready" | "blocked" | "unknown";
}

export interface ArtifactManifest {
  version: 1;
  coverage: { source: "observed" | "snapshot"; complete: boolean; reasons: ArtifactManifestReason[] };
  artifacts: ArtifactManifestEntry[];
  checks: ArtifactManifestCheck[];
  dependencies: ArtifactManifestDependency[];
  bytesHashed: number;
  omitted: number;
}

export interface CollectArtifactManifestInput {
  workingDir: string;
  roots: readonly string[];
  artifacts: readonly ArtifactObservation[];
  checks?: readonly ArtifactManifestCheck[];
  dependencies?: readonly ArtifactManifestDependency[];
  signal: AbortSignal;
  /** Snapshot means the caller supplies an authoritative inventory, never a worker claim. */
  coverage?: "observed" | "snapshot";
  incomplete?: readonly ArtifactManifestReason[];
  limits?: { entries?: number; bytes?: number; fileBytes?: number; durationMs?: number };
}
