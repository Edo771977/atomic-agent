import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { describeModelListError } from "./describe-model-list-error.js";
import { createProvidersWizardState } from "./providers-wizard-state.js";
import type { ProvidersWizardState } from "./providers-wizard-state.js";

const SHARED = ["OPENAI_COMPAT_API_KEY", "OPENAI_API_KEY", "ATOMIC_AGENT_OPENAI_API_KEY"] as const;

function compat(baseUrlLine: string, apiKeyBuffer = ""): ProvidersWizardState {
  return {
    ...createProvidersWizardState("add", { kind: "openai-compatible" }),
    phase: "chat_model_line",
    baseUrlLine,
    apiKeyBuffer,
  };
}

describe("describeModelListError", () => {
  beforeEach(() => {
    for (const key of SHARED) delete process.env[key];
  });
  afterEach(() => {
    for (const key of SHARED) delete process.env[key];
  });

  it("does not call a key rejected when none was sent (ATO-1066)", () => {
    process.env.OPENAI_COMPAT_API_KEY = "sk-SHARED";
    const line = describeModelListError("http 401", compat("http://192.168.1.20:8080"), "this endpoint");
    expect(line).not.toContain("rejected");
    expect(line).toContain("no key was sent");
    // Why none was sent, when the operator expects the shared one to be.
    expect(line).toContain("OPENAI_COMPAT_API_KEY is not sent to other computers");
  });

  it("says no key was sent for a 403 without a key either", () => {
    const line = describeModelListError("http 403 forbidden", compat("http://192.168.1.20:8080"), "this endpoint");
    expect(line).toContain("no key was sent");
    expect(line).not.toContain("OPENAI_COMPAT_API_KEY");
  });

  it("still says the key was rejected when one was sent", () => {
    const line = describeModelListError("http 401", compat("http://192.168.1.20:8080", "lan-key"), "this endpoint");
    expect(line).toContain("rejected this key");
  });

  it("keeps the other wording", () => {
    expect(describeModelListError("http 404", compat("https://api.example.com", "k"), "X")).toBe(
      "X has no model list at this URL",
    );
    expect(describeModelListError("boom", compat("https://api.example.com", "k"), "X")).toBe(
      "could not list models from X (boom)",
    );
  });
});
