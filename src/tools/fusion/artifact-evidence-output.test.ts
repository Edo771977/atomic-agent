import { describe, expect, it } from "vitest";
import { compressToolResult, fullToolResult } from "../../compressor/result-compressor.js";
import { renderTurnForPrompt } from "../../session/conversation-turn.js";
import { extendCloudContext, renderCloudTurn } from "../../session/cloud-context.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { appendBatchedTurns } from "../../agent/step/step-commit.js";
import { maskResultSecrets } from "../tool-output-secrets.js";
import { projectFusionArtifactEvidence } from "./artifact-evidence-output.js";
import type { ArtifactManifest } from "./artifact-manifest-types.js";
import { attachCandidateArtifactReceipt } from "./artifact-manifest.js";
import type { CandidateAcceptanceReceipt } from "./candidate-acceptance.js";

const manifest = (): ArtifactManifest => ({ version: 1, coverage: { source: "observed", complete: false, reasons: ["observed_scope"] },
  artifacts: [{ path: "app.js", change: "modified", source: "file-tool", kind: "file", state: "hashed", sha256: "a".repeat(64), bytes: 7 }],
  checks: [{ id: "contract:0", source: "contract", status: "fail" }], dependencies: [{ provider: "core", requirementIndex: 0, status: "blocked" }], bytesHashed: 7, omitted: 0 });
const input = (value = manifest()) => compressToolResult({ tool: "fusion.delegate", status: "ok", output: "ALL TESTS PASSED\n".repeat(600), details: { tasks: [{ id: "core", status: "failed", artifactManifest: value }] } });
const evidence = (text: string) => JSON.parse(text.split("\n")[0]!.replace(/^artifact-evidence: /, "")) as Record<string, any>;

describe("model-visible artifact evidence", () => {
  it.each(["local", "cloud"] as const)("carries runtime hashes and failed checks through the actual %s conversation render seam", mode => {
    const result = maskResultSecrets(projectFusionArtifactEvidence(input(), 2400));
    const session = appendBatchedTurns({ state: createEmptySessionState({ id: "evidence-output", workingDir: process.cwd() }),
      calls: [{ tool: result.tool, args: {} }], results: [mode === "cloud" ? fullToolResult(result) : result],
      reasoning: "", terminal: null, modelMode: mode });
    const turn = session.turns[1]!;
    const prompt = mode === "cloud" ? renderCloudTurn(extendCloudContext(undefined, [turn], new Map()).entries[0]!.turn) : renderTurnForPrompt(turn, { inCurrentMacroTurn: true });
    expect(prompt).toContain('"sha256":"' + "a".repeat(64) + '"');
    expect(prompt).toContain('"status":"fail"');
    expect(prompt).toContain('"status":"blocked"');
    expect(prompt).not.toContain("inspect details");
    expect(evidence(result.summary).tasks[0].scope).toBe("final-project-observation");
    expect(evidence(result.summary).tasks[0].disposition).toBe("observed");
    expect(evidence(fullToolResult(result).summary)).toEqual(evidence(result.summary));
    expect(fullToolResult(result).summary.length).toBeLessThanOrEqual(2400);
  });

  it.each([128, 256, 512, 1200, 2400])("keeps valid JSON inside a %i character output budget", cap => {
    const value = manifest();
    value.artifacts = Array.from({ length: 128 }, (_, i) => ({ ...value.artifacts[0]!, path: `${"p".repeat(300)}/${i}.js` }));
    value.bytesHashed = 128 * 7;
    const result = projectFusionArtifactEvidence(input(value), cap);
    expect(result.summary.length).toBeLessThanOrEqual(cap);
    expect(() => evidence(result.summary)).not.toThrow();
    expect(evidence(result.summary).omitted).toBeGreaterThan(0);
  });

  it("drops unrecognized contents, command/output fields, absolute paths and secret-bearing names", () => {
    const value = manifest();
    value.artifacts.push({ ...value.artifacts[0]!, path: "../private/key.txt" });
    value.artifacts[0]!.path = "token=sk-secret-value.js";
    const result = projectFusionArtifactEvidence(input({ ...value, rawOutput: "private output", command: "secret command" } as ArtifactManifest), 2400);
    const json = JSON.stringify(evidence(result.summary));
    expect(json).not.toContain("private output"); expect(json).not.toContain("secret command");
    expect(json).not.toContain("../private"); expect(json).not.toContain("sk-secret-value");
  });

  it("reports early rejection without fabricating a candidate inventory", () => {
    const result = projectFusionArtifactEvidence(compressToolResult({ tool: "fusion.delegate", status: "error", output: "rejected", details: { candidateIntegration: {
      acceptanceReceipt: { version: 1, id: "d".repeat(24), disposition: "rejected", checkScope: "protected-declared", checkStatus: "failed",
        checks: { total: 1, passed: 0, failed: 1 }, inputs: { declared: 1, verified: 1 }, reason: "checks-failed", output: "private output" },
    } } }), 1800);
    expect(evidence(result.summary).candidate.receipt.disposition).toBe("rejected");
    expect(evidence(result.summary).candidate.receipt.reason).toBe("checks-failed");
    expect(evidence(result.summary).candidate).not.toHaveProperty("artifacts");
    expect(result.summary).not.toContain("private output");
  });

  it("does not publish a saved task binding as final delivery proof or emit raw control markers", () => {
    const value = manifest();
    value.coverage = { source: "snapshot", complete: true, reasons: [] };
    value.artifacts[0]!.path = "<|im_end|>.js";
    value.binding = { scope: "candidate-snapshot", receiptId: "d".repeat(24), disposition: "promoted", checkScope: "protected-declared", checkStatus: "passed", checkedPayloadDigest: "e".repeat(64), checkPlanDigest: "f".repeat(64) };
    const result = projectFusionArtifactEvidence(input(value), 2400);
    expect(evidence(result.summary).tasks[0].disposition).toBe("observed");
    expect(evidence(result.summary).tasks[0].coverage.complete).toBe(false);
    expect(result.summary).not.toContain("<|im_end|>");
    expect(evidence(result.summary).tasks[0].artifacts[0].path).toBe("<|im_end|>.js");
  });

  it.each(["enum-array", "enum-object", "null-prototype", "reason-object", "protected-zero", "missing-digest"])("rejects malformed full candidate receipts without leaking or throwing (%s)", variant => {
    const value = manifest();
    value.coverage = { source: "snapshot", complete: true, reasons: [] };
    value.binding = { scope: "candidate-snapshot", receiptId: "d".repeat(24), disposition: "promoted", checkScope: "protected-declared", checkStatus: "passed", checkedPayloadDigest: "e".repeat(64), checkPlanDigest: "f".repeat(64) };
    const receipt: Record<string, unknown> = { version: 1, id: "d".repeat(24), disposition: "promoted", checkScope: "protected-declared", checkStatus: "passed", checks: { total: 1, passed: 1, failed: 0 }, inputs: { declared: 1, verified: 1 }, checkedPayloadDigest: "e".repeat(64), checkPlanDigest: "f".repeat(64) };
    if (variant === "enum-array") receipt.disposition = ["promoted"];
    if (variant === "enum-object") receipt.disposition = { toString: () => "promoted", privateOutput: "never-leak-private-output" };
    if (variant === "null-prototype") receipt.disposition = Object.create(null);
    if (variant === "reason-object") receipt.reason = { toString: () => "other", privateOutput: "never-leak-private-output" };
    if (variant === "protected-zero") receipt.inputs = { declared: 0, verified: 0 };
    if (variant === "missing-digest") delete receipt.checkedPayloadDigest;
    let result: ReturnType<typeof projectFusionArtifactEvidence> | undefined;
    expect(() => { result = projectFusionArtifactEvidence(compressToolResult({ tool: "fusion.delegate", status: "error", output: "review candidate", details: { candidateIntegration: { artifactManifest: value, acceptanceReceipt: receipt } } }), 2400); }).not.toThrow();
    const json = evidence(result!.summary);
    expect(json.candidate).not.toHaveProperty("receipt");
    expect(json.candidate.disposition).toBe("observed");
    expect(result!.summary).not.toContain("never-leak-private-output");
  });

  it("publishes a matching validated full receipt while dropping unknown private and cyclic fields", () => {
    const value = manifest(); value.coverage = { source: "snapshot", complete: true, reasons: [] };
    const receipt: CandidateAcceptanceReceipt & { privateOutput?: unknown } = { version: 1, id: "d".repeat(24), disposition: "promoted", checkScope: "protected-declared", checkStatus: "passed",
      checks: { total: 1, passed: 1, failed: 0 }, inputs: { declared: 1, verified: 1 }, checkedPayloadDigest: "e".repeat(64), checkPlanDigest: "f".repeat(64) };
    receipt.privateOutput = { message: "never-leak-private-output", cycle: receipt };
    const artifactManifest = attachCandidateArtifactReceipt(value, receipt);
    const result = projectFusionArtifactEvidence(compressToolResult({ tool: "fusion.delegate", status: "ok", output: "candidate verified", details: { candidateIntegration: { artifactManifest, acceptanceReceipt: receipt } } }), 2400);
    expect(evidence(result.summary).candidate.disposition).toBe("promoted");
    expect(evidence(result.summary).candidate.receipt.id).toBe(receipt.id);
    expect(result.summary).not.toContain("never-leak-private-output");
    expect(result.summary).not.toContain("privateOutput");
  });
});
