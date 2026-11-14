/** Runtime-owned integrity guard for explicitly declared check inputs, applied to each actual execution copy. */
export interface VerificationInputIntegrity {
  /** Verify baseline bytes, then return the completion check for this exact workspace identity. */
  begin(workingDir: string, signal: AbortSignal): Promise<() => Promise<void>>;
}
