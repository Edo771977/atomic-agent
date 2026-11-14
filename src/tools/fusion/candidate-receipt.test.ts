import { describe, expect, it, vi } from "vitest";
import { parseCandidateAcceptanceReceipt } from "./candidate-receipt.js";
import type { CandidateAcceptanceReceipt } from "./candidate-acceptance.js";

const receipt: CandidateAcceptanceReceipt = { version: 1, id: "a".repeat(24), disposition: "promoted", checkScope: "protected-declared", checkStatus: "passed",
  checks: { total: 2, passed: 2, failed: 0 }, inputs: { declared: 1, verified: 1 }, checkedPayloadDigest: "b".repeat(64), checkPlanDigest: "c".repeat(64) };
describe("canonical candidate receipt parser", () => {
  it("copies a validated scalar whitelist and drops private extras without retaining aliases", () => {
    const source = { ...receipt, inputs: { ...receipt.inputs, privatePath: "secret" }, extra: { privatePath: "secret" } };
    const parsed = parseCandidateAcceptanceReceipt(source)!;
    expect(parsed).toEqual(receipt);
    expect(parsed).not.toBe(source);
    expect(parsed.inputs).not.toBe(source.inputs);
    expect(JSON.stringify(parsed)).not.toContain("secret");
    source.inputs.verified = 0;
    expect(parsed.inputs.verified).toBe(1);
    expect(parseCandidateAcceptanceReceipt(Object.assign(Object.create(null), receipt))).toEqual(receipt);
    expect(parseCandidateAcceptanceReceipt({ ...receipt, disposition: "unchanged" })).toMatchObject({ disposition: "unchanged" });
  });
  it("accepts honest failed or unverified rejection without inventing missing digests", () => {
    const rejected = { ...receipt, disposition: "rejected", checkScope: "declared", checkStatus: "unverified", reason: "check-inputs-changed",
      checks: { total: 2, passed: 0, failed: 0 }, inputs: { declared: 1, verified: 0 }, checkedPayloadDigest: undefined, checkPlanDigest: undefined };
    expect(parseCandidateAcceptanceReceipt(rejected)).toMatchObject({ disposition: "rejected", inputs: { declared: 1, verified: 0 } });
    expect(parseCandidateAcceptanceReceipt({ ...rejected, checkStatus: "failed", checks: { total: 2, passed: 1, failed: 1 } })).toMatchObject({ checkStatus: "failed" });
  });
  it("requires actual string enums and never coerces malformed valid JSON", () => {
    for (const key of ["disposition", "checkScope", "checkStatus", "reason"] as const) {
      for (const value of [[receipt[key]], { toString: null }, {}, null, 1, false]) {
        const malformed: unknown = JSON.parse(JSON.stringify({ ...receipt, [key]: value }));
        expect(() => parseCandidateAcceptanceReceipt(malformed)).not.toThrow();
        expect(parseCandidateAcceptanceReceipt(malformed)).toBeUndefined();
      }
    }
  });
  it("rejects prototypes, accessors, hostile proxies and nested cycles without invoking getters", () => {
    const getter = vi.fn(() => "declared");
    const accessor = { ...receipt };
    Object.defineProperty(accessor, "checkScope", { enumerable: true, get: getter });
    const custom = Object.assign(Object.create({ privatePath: "secret" }), receipt);
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const cycle = { ...receipt, checks: {} }; cycle.checks = cycle;
    for (const malformed of [accessor, custom, revoked.proxy, cycle, { ...receipt, inputs: new Date() }]) {
      expect(() => parseCandidateAcceptanceReceipt(malformed)).not.toThrow();
      expect(parseCandidateAcceptanceReceipt(malformed)).toBeUndefined();
    }
    expect(getter).not.toHaveBeenCalled();
    const harmlessCycle = { ...receipt, privateExtra: {} }; harmlessCycle.privateExtra = harmlessCycle;
    expect(parseCandidateAcceptanceReceipt(harmlessCycle)).toEqual(receipt);
  });
  it("rejects inconsistent counts, promotion without digests and unearned protection claims", () => {
    for (const over of [{ checkedPayloadDigest: undefined }, { checkPlanDigest: undefined }, { checkedPayloadDigest: "b".repeat(63) },
      { checks: { total: 0, passed: 0, failed: 0 } }, { checks: { total: 1, passed: 2, failed: 0 } },
      { checks: { total: 1_000_001, passed: 1_000_001, failed: 0 } }, { checks: { total: 1.5, passed: 1, failed: 0 } },
      { checks: { total: NaN, passed: 0, failed: 0 } }, { inputs: { declared: 0, verified: 0 } }, { inputs: { declared: 1, verified: 0 } },
      { inputs: { declared: 0, verified: 1 } }, { reason: "other" }, { checkStatus: "unverified" },
      { disposition: "rejected", inputs: { declared: 0, verified: 0 } }, { disposition: "rejected", inputs: { declared: 1, verified: 0 } }]) {
      expect(parseCandidateAcceptanceReceipt({ ...receipt, ...over }), JSON.stringify(over)).toBeUndefined();
    }
  });
});
