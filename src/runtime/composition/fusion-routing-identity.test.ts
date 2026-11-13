import { describe, expect, it } from "vitest";
import { configuredFusionRoutingIdentity } from "./fusion-routing-identity.js";

describe("configured Fusion request identity", () => {
  const entry = { id: "gateway", kind: "openai-compatible", baseUrl: "https://user:password@example.test/v1/", defaultChatModel: "actual-a" };
  it("changes when the configured request model or endpoint changes, independent of display labels", () => {
    const original = configuredFusionRoutingIdentity(entry);
    expect(original).toMatch(/^[a-f0-9]{64}$/);
    expect(configuredFusionRoutingIdentity({ ...entry, defaultChatModel: "actual-b" })).not.toBe(original);
    expect(configuredFusionRoutingIdentity({ ...entry, baseUrl: "https://example.test/deployment/v1" })).not.toBe(original);
    expect(configuredFusionRoutingIdentity({ ...entry, baseUrl: "https://other:credential@example.test/v1" })).toBe(original);
    expect(configuredFusionRoutingIdentity({ ...entry, apiKey: "secret", headers: { Authorization: "secret" } })).toBe(original);
    expect(original).not.toContain("password");
  });
  it("declines query-routed endpoints, missing models, automatic selectors and unknown adapters", () => {
    for (const over of [{ baseUrl: "https://example.test/v1?token=secret" }, { defaultChatModel: undefined }, { defaultChatModel: "openrouter/auto" }, { kind: "custom" }, { kind: "subscription-cli" }]) {
      expect(configuredFusionRoutingIdentity({ ...entry, ...over })).toBeUndefined();
    }
  });
  it("recognizes only the managed main local server with matching configured and live model IDs", () => {
    const local = { mode: "managed" as const, url: "http://127.0.0.1:8080", configuredModelId: "model-a", liveModelId: "model-a" };
    const provider = { id: "local", kind: "llama-server", url: local.url };
    expect(configuredFusionRoutingIdentity(provider, local)).toMatch(/^[a-f0-9]{64}$/);
    expect(configuredFusionRoutingIdentity(provider, { ...local, mode: "external" })).toBeUndefined();
    expect(configuredFusionRoutingIdentity(provider, { ...local, liveModelId: "old-model" })).toBeUndefined();
    expect(configuredFusionRoutingIdentity({ ...provider, url: "http://127.0.0.1:8081" }, local)).toBeUndefined();
  });
});
