/** Runtime-owned integrity guard for explicitly declared check inputs, applied to each actual execution copy. */
export interface VerificationInputIntegrity {
  /** Frozen project-relative files whose excluded ancestors must be copied privately. */
  readonly paths?: readonly string[];
  /** Verify baseline bytes, then return the completion check for this exact workspace identity. */
  begin(workingDir: string, signal: AbortSignal): Promise<() => Promise<void>>;
}
