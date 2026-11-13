import { describe, expect, it } from "vitest";
import { isLocalServerUrl } from "../openai/local-server-url.js";
import { isOtherComputerOnNetworkUrl } from "../openai/network-server-address.js";
import { isLocalProviderUrl } from "./is-local-provider-url.js";

describe("isLocalProviderUrl", () => {
  it("accepts this machine however the host is spelled", () => {
    for (const url of ["http://localhost:8080", "http://LOCALHOST:8080", "http://localhost.:8080", "http://127.0.0.1",
      "http://[::1]:8080", "http://0.0.0.0:8080", "http://studio.localhost", "http://studio.localhost.:1234"]) {
      expect(isLocalProviderUrl(url), url).toBe(true);
    }
  });

  it("rejects other hosts and unparsable input", () => {
    for (const url of ["http://192.168.1.20", "https://api.openai.com", "http://localhost.evil.com", "nope", "", undefined]) {
      expect(isLocalProviderUrl(url), String(url)).toBe(false);
    }
  });

  it("agrees with the network classifiers: a trailing-dot localhost is not another computer", () => {
    expect(isLocalServerUrl("http://localhost.:8080")).toBe(true);
    expect(isOtherComputerOnNetworkUrl("http://localhost.:8080")).toBe(false);
    expect(isOtherComputerOnNetworkUrl("http://gpu.local.:8080")).toBe(true);
  });
});
