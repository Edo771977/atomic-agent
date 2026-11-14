import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachCandidateArtifactReceipt, collectArtifactManifest, parseArtifactManifest } from "./artifact-manifest.js";
import type { CollectArtifactManifestInput } from "./artifact-manifest-types.js";
import type { CandidateAcceptanceReceipt } from "./candidate-acceptance.js";

describe("runtime artifact manifest", () => {
  let dir: string;
  let outside: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-manifest-"));
    outside = mkdtempSync(join(tmpdir(), "fusion-outside-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const signal = () => new AbortController().signal;
  const input = (over: Partial<CollectArtifactManifestInput> = {}): CollectArtifactManifestInput => ({
    workingDir: dir, roots: [dir], signal: signal(), coverage: "snapshot",
    artifacts: [{ path: "file.txt", change: "new", source: "snapshot" }], ...over,
  });

  it("hashes actual bytes, detects later tampering, and never retains file contents", async () => {
    writeFileSync(join(dir, "file.txt"), "first secret bytes");
    const first = await collectArtifactManifest(input());
    writeFileSync(join(dir, "file.txt"), "tampered secret bytes");
    const second = await collectArtifactManifest(input());
    expect(first.artifacts[0]).toMatchObject({ path: "file.txt", kind: "file", state: "hashed", sha256: createHash("sha256").update("first secret bytes").digest("hex") });
    expect(second.artifacts[0]!.sha256).not.toBe(first.artifacts[0]!.sha256);
    expect(JSON.stringify(second)).not.toContain("tampered secret bytes");
    expect(first.coverage.complete).toBe(true);
  });

  it("distinguishes a confirmed deletion from an unexpectedly missing artifact", async () => {
    const manifest = await collectArtifactManifest(input({ artifacts: [{ path: "deleted.txt", change: "deleted", source: "snapshot" }, { path: "missing.txt", change: "new", source: "snapshot" }] }));
    expect(manifest.artifacts.map(e => e.kind)).toEqual(["deleted", "missing"]);
    expect(manifest.coverage.complete).toBe(false);
    expect(manifest.coverage.reasons).toContain("missing_artifact");
  });

  it("does not certify a snapshot deletion whose path has been recreated", async () => {
    writeFileSync(join(dir, "file.txt"), "recreated");
    const manifest = await collectArtifactManifest(input({ artifacts: [{ path: "file.txt", change: "deleted", source: "snapshot" }] }));
    expect(manifest.coverage.complete).toBe(false);
    expect(manifest.coverage.reasons).toContain("changed_during_read");
  });

  it("keeps canonical relative paths and records the actual mode", async () => {
    writeFileSync(join(dir, "file.txt"), "actual");
    const manifest = await collectArtifactManifest(input({ artifacts: [{ path: join(dir, ".", "file.txt"), change: "mode", source: "snapshot" }] }));
    expect(manifest.artifacts[0]).toMatchObject({ path: "file.txt", change: "mode", mode: lstatSync(join(dir, "file.txt")).mode });
  });

  it("hashes a symlink itself and refuses reads through an outside ancestor link", async context => {
    writeFileSync(join(outside, "secret.txt"), "outside bytes");
    const link = join(dir, "link");
    try { symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        console.warn("manifest symlink fixture unavailable on this host; assertion requires symlink/junction capability");
        context.skip(); return;
      }
      throw error;
    }
    const manifest = await collectArtifactManifest(input({ artifacts: [{ path: "link", change: "new", source: "snapshot" }, { path: "link/secret.txt", change: "observed", source: "snapshot" }] }));
    expect(manifest.artifacts[0]).toMatchObject({ kind: "symlink", state: "hashed", sha256: createHash("sha256").update(readlinkSync(link, { encoding: "buffer" })).digest("hex") });
    expect(manifest.artifacts[1]).toMatchObject({ state: "outside_scope" });
    expect(manifest.artifacts[1]!.sha256).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain("outside bytes");
    expect(JSON.stringify(manifest)).not.toContain(outside);
  });

  it("does not inspect artifacts outside the supplied roots", async () => {
    writeFileSync(join(outside, "secret.txt"), "outside bytes");
    const manifest = await collectArtifactManifest(input({ artifacts: [{ path: join(outside, "secret.txt"), change: "observed", source: "declared" }] }));
    expect(manifest.artifacts[0]).toMatchObject({ state: "outside_scope" });
    expect(manifest.artifacts[0]!.sha256).toBeUndefined();
    expect(manifest.coverage.reasons).toContain("outside_scope");
  });

  it("returns incomplete evidence for an aborted collection", async () => {
    const controller = new AbortController();
    controller.abort();
    const manifest = await collectArtifactManifest(input({ signal: controller.signal }));
    expect(manifest.coverage.complete).toBe(false);
    expect(manifest.coverage.reasons).toContain("aborted");
    expect(manifest.artifacts.every(e => e.sha256 === undefined)).toBe(true);
  });

  it("retains cancellation even when an authoritative inventory is empty", async () => {
    const controller = new AbortController();
    controller.abort();
    const manifest = await collectArtifactManifest(input({ artifacts: [], signal: controller.signal }));
    expect(manifest.coverage.complete).toBe(false);
    expect(manifest.coverage.reasons).toContain("aborted");
  });

  it("treats a zero time budget as incomplete even for an empty snapshot", async () => {
    const manifest = await collectArtifactManifest(input({ artifacts: [], limits: { durationMs: 0 } }));
    expect(manifest.coverage.complete).toBe(false);
    expect(manifest.coverage.reasons).toContain("aborted");
  });

  it("honors entry and byte ceilings without claiming complete coverage", async () => {
    writeFileSync(join(dir, "file.txt"), "too many bytes");
    const limited = await collectArtifactManifest(input({ artifacts: [{ path: "file.txt", change: "new", source: "snapshot" }, { path: "other.txt", change: "new", source: "snapshot" }], limits: { entries: 1, bytes: 2, fileBytes: 2 } }));
    expect(limited.artifacts).toHaveLength(1);
    expect(limited.artifacts[0]!.sha256).toBeUndefined();
    expect(limited.omitted).toBe(1);
    expect(limited.coverage.complete).toBe(false);
    expect(limited.bytesHashed).toBeLessThanOrEqual(2);
  });

  it("never upgrades observed or untracked-shell inventory to full-world coverage", async () => {
    const manifest = await collectArtifactManifest(input({ coverage: "observed", artifacts: [], incomplete: ["untracked_writes"] }));
    expect(manifest.coverage).toMatchObject({ source: "observed", complete: false });
    expect(manifest.coverage.reasons).toEqual(expect.arrayContaining(["observed_scope", "untracked_writes"]));
  });

  it("keeps unavailable verification explicitly unknown rather than deriving a pass", async () => {
    const manifest = await collectArtifactManifest(input({ artifacts: [], checks: [{ id: "contract:0", source: "contract", status: "unknown" }], dependencies: [{ provider: "core", requirementIndex: 0, status: "unknown" }] }));
    expect(manifest.checks[0]!.status).toBe("unknown");
    expect(manifest.dependencies[0]!.status).toBe("unknown");
    expect(manifest.coverage.reasons).toContain("verification_unknown");
  });

  it("binds only authoritative candidate snapshots and preserves the validated optional v1 extension", async () => {
    writeFileSync(join(dir, "file.txt"), "candidate bytes");
    const snapshot = await collectArtifactManifest(input());
    const receipt = { version: 1 as const, id: "a".repeat(24), disposition: "promoted" as const, checkScope: "protected-declared" as const,
      checkStatus: "passed" as const, checkedPayloadDigest: "b".repeat(64), checkPlanDigest: "c".repeat(64), checks: { total: 1, passed: 1, failed: 0 }, inputs: { declared: 1, verified: 1 } };
    const bound = attachCandidateArtifactReceipt(snapshot, receipt);
    expect(bound.binding).toEqual({ scope: "candidate-snapshot", receiptId: receipt.id, disposition: "promoted", checkScope: "protected-declared", checkStatus: "passed", checkedPayloadDigest: receipt.checkedPayloadDigest, checkPlanDigest: receipt.checkPlanDigest });
    expect(parseArtifactManifest(JSON.parse(JSON.stringify(bound)))?.binding).toEqual(bound.binding);
    const observed = await collectArtifactManifest(input({ coverage: "observed" }));
    expect(attachCandidateArtifactReceipt(observed, receipt).binding?.disposition).not.toBe("promoted");
    expect(parseArtifactManifest({ ...bound, binding: { ...bound.binding, scope: "final-project-observation" } })).toBeUndefined();
    expect(parseArtifactManifest({ ...bound, binding: { ...bound.binding, receiptId: "secret arbitrary id" } })).toBeUndefined();
    expect(parseArtifactManifest({ ...bound, binding: { ...bound.binding, command: "private-command" } })?.binding).not.toHaveProperty("command");
  });

  it.each(["protected-zero", "missing-counts", "count-mismatch", "enum-array"])("does not attach accepted proof from an invalid full runtime receipt (%s)", async variant => {
    writeFileSync(join(dir, "file.txt"), "candidate bytes");
    const snapshot = await collectArtifactManifest(input());
    const receipt: Record<string, unknown> = { version: 1, id: "a".repeat(24), disposition: "promoted", checkScope: "protected-declared", checkStatus: "passed",
      checkedPayloadDigest: "b".repeat(64), checkPlanDigest: "c".repeat(64), checks: { total: 1, passed: 1, failed: 0 }, inputs: { declared: 1, verified: 1 } };
    if (variant === "protected-zero") receipt.inputs = { declared: 0, verified: 0 };
    if (variant === "missing-counts") delete receipt.checks;
    if (variant === "count-mismatch") receipt.checks = { total: 2, passed: 1, failed: 0 };
    if (variant === "enum-array") receipt.disposition = ["promoted"];
    expect(attachCandidateArtifactReceipt(snapshot, receipt as unknown as CandidateAcceptanceReceipt).binding).toBeUndefined();
  });

  it.each([
    { path: null, kind: "file", state: "hashed", sha256: "0".repeat(64), bytes: 12 },
    { path: "file.txt", kind: "file", state: "metadata" },
  ])("rejects impossible persisted artifact combinations $kind/$state/$path", entry => {
    expect(parseArtifactManifest({ version: 1, coverage: { source: "snapshot", complete: true, reasons: [] }, artifacts: [{ change: "new", source: "snapshot", ...entry }], checks: [], dependencies: [], bytesHashed: 12, omitted: 0 })).toBeUndefined();
  });
});
