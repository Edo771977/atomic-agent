import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { resolveLlmProviderApiKey } from "./resolve-llm-api-key.js";

describe("resolveLlmProviderApiKey", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("resolves Gemini keys from GEMINI_API_KEY", () => {
    vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");

    expect(resolveLlmProviderApiKey({ id: "gemini", kind: "gemini" })).toBe(
      "gemini-test-key",
    );
  });
});

describe("resolveLlmProviderApiKey for a server on another computer (ATO-1066)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("never sends the shared OpenAI key to a LAN address", () => {
    // Unset, not empty: an empty OPENAI_COMPAT_API_KEY would win the `??`
    // chain and hide the leak this test is about.
    const saved = {
      OPENAI_COMPAT_API_KEY: process.env.OPENAI_COMPAT_API_KEY,
      ATOMIC_AGENT_OPENAI_API_KEY: process.env.ATOMIC_AGENT_OPENAI_API_KEY,
    };
    delete process.env.OPENAI_COMPAT_API_KEY;
    delete process.env.ATOMIC_AGENT_OPENAI_API_KEY;
    onTestFinished(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value !== undefined) process.env[name] = value;
      }
    });
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    expect(
      resolveLlmProviderApiKey({
        id: "custom-192-168-1-20-8080",
        kind: "openai-compatible",
        baseUrl: "http://192.168.1.20:8080",
      }),
    ).toBeUndefined();
  });

  it("still uses the LAN entry's own key or key variable", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("ATOMIC_AGENT_KEY_LAN", "lan-key");
    expect(
      resolveLlmProviderApiKey({
        id: "lan",
        kind: "openai-compatible",
        baseUrl: "http://192.168.1.20:8080",
        apiKey: "stored",
      }),
    ).toBe("stored");
    expect(
      resolveLlmProviderApiKey({
        id: "lan",
        kind: "openai-compatible",
        baseUrl: "http://192.168.1.20:8080",
        apiKeyEnvVar: "ATOMIC_AGENT_KEY_LAN",
      }),
    ).toBe("lan-key");
  });

  it("keeps the shared fallback for a cloud endpoint", () => {
    vi.stubEnv("OPENAI_COMPAT_API_KEY", "sk-test");
    expect(
      resolveLlmProviderApiKey({
        id: "openai-compatible",
        kind: "openai-compatible",
        baseUrl: "https://api.openai.com",
      }),
    ).toBe("sk-test");
  });
});

describe("resolveLlmProviderApiKey: the shared OpenAI key goes only over https or to this machine", () => {
  afterEach(() => vi.unstubAllEnvs());

  function withSharedKey(): void {
    for (const name of ["OPENAI_COMPAT_API_KEY", "ATOMIC_AGENT_OPENAI_API_KEY"]) {
      const saved = process.env[name];
      delete process.env[name];
      onTestFinished(() => {
        if (saved !== undefined) process.env[name] = saved;
      });
    }
    vi.stubEnv("OPENAI_API_KEY", "sk-shared");
  }

  const compat = (baseUrl?: string) => ({
    id: "custom",
    kind: "openai-compatible" as const,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });

  it("keeps the fallback for an https endpoint, even on a public IP", () => {
    withSharedKey();
    expect(resolveLlmProviderApiKey(compat("https://8.8.8.8"))).toBe("sk-shared");
    expect(resolveLlmProviderApiKey(compat("https://api.together.xyz"))).toBe("sk-shared");
  });

  it("keeps the fallback when no baseUrl is set (the default endpoint is https)", () => {
    withSharedKey();
    expect(resolveLlmProviderApiKey(compat())).toBe("sk-shared");
  });

  it("sends no shared key over plain http to a public host", () => {
    withSharedKey();
    for (const url of ["http://8.8.8.8", "http://api.example.com:8080", "http://[2001:db8::1]"]) {
      expect(resolveLlmProviderApiKey(compat(url)), url).toBeUndefined();
    }
    expect(resolveLlmProviderApiKey({ ...compat("http://8.8.8.8"), kind: "qwen-openai-compatible" })).toBeUndefined();
  });

  it("sends no shared key over https to a name of the operator's own network", () => {
    withSharedKey();
    for (const url of [
      "https://gpu.tail1234.ts.net",
      "https://nas.home",
      "https://gpu.localdomain",
      "https://gpu.corp",
      "https://wiki.intranet",
      "https://192.168.1.5.nip.io",
      "https://whatever.sslip.io",
    ]) {
      expect(resolveLlmProviderApiKey(compat(url)), url).toBeUndefined();
    }
    expect(resolveLlmProviderApiKey(compat("https://8.8.8.8.nip.io"))).toBe("sk-shared");
  });

  it("keeps the fallback over plain http to this machine", () => {
    withSharedKey();
    for (const url of ["http://localhost:8080", "http://127.0.0.2:8080", "http://[::1]:8080", "http://0.0.0.0:8080", "http://[::]:8080", "http://localhost.:8080"]) {
      expect(resolveLlmProviderApiKey(compat(url)), url).toBe("sk-shared");
    }
  });

  it("still honours an explicit apiKeyEnvVar naming a shared variable, and a stored key", () => {
    withSharedKey();
    expect(resolveLlmProviderApiKey({ ...compat("http://8.8.8.8"), apiKeyEnvVar: "OPENAI_API_KEY" })).toBe("sk-shared");
    expect(resolveLlmProviderApiKey({ ...compat("http://8.8.8.8"), apiKey: "own" })).toBe("own");
  });
});
