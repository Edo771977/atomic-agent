import { describe, expect, it } from "vitest";

import type { UserLlmProviderEntry } from "../../config/llm-config.js";
import { storedEntryAtBaseUrl } from "./stored-provider-entry.js";

const withKey = (baseUrl?: string): UserLlmProviderEntry => ({
  id: "c",
  kind: "openai-compatible",
  ...(baseUrl !== undefined ? { baseUrl } : {}),
  apiKey: "sk-literal",
});

describe("storedEntryAtBaseUrl", () => {
  it("drops a literal key when the entry moves to another server", () => {
    // The key belonged to the old server's account: over plain http:// it
    // would cross the network in clear, and over https it reaches a
    // different party.
    for (const [from, to] of [
      ["https://api.openai.com", "http://203.0.113.5:8000"],
      ["https://api.openai.com", "https://other.example.com"],
      ["https://api.example.com", "http://api.example.com"],
      ["https://api.example.com", "https://api.example.com:8443"],
      ["https://api.example.com", "http://192.168.1.5:8080"],
      [undefined, "https://other.example.com"],
    ] as const) {
      const moved = storedEntryAtBaseUrl(withKey(from), to);
      expect(moved.apiKey, `${from} -> ${to}`).toBeUndefined();
      expect(moved.baseUrl).toBe(to);
    }
  });

  it("keeps it on the same server, whatever the path or spelling", () => {
    for (const [from, to] of [
      ["https://api.example.com", "https://api.example.com/v1"],
      ["https://API.example.com", "https://api.example.com"],
      ["https://api.example.com:443", "https://api.example.com"],
      ["http://192.168.1.5:8080", "192.168.1.5:8080"],
      [undefined, "https://api.openai.com"],
    ] as const) {
      expect(storedEntryAtBaseUrl(withKey(from), to).apiKey, `${from} -> ${to}`).toBe("sk-literal");
    }
  });

  it("always lets an apiKeyEnvVar follow the entry", () => {
    const stored: UserLlmProviderEntry = {
      id: "c",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com",
      apiKeyEnvVar: "MY_KEY",
    };
    expect(storedEntryAtBaseUrl(stored, "http://203.0.113.5:8000").apiKeyEnvVar).toBe("MY_KEY");
  });
});
