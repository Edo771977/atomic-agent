import { describe, expect, it } from "vitest";
import { isLocalProviderUrl } from "../presets/is-local-provider-url.js";
import { classifiableHostOf } from "../url-host.js";
import { isLocalServerUrl } from "./local-server-url.js";
import {
  describeOtherComputerUnreachable,
  isOtherComputerOnNetworkUrl,
  normalizeNetworkServerAddress,
  withAssumedScheme,
} from "./network-server-address.js";

describe("normalizeNetworkServerAddress", () => {
  it("turns an address typed as read off the other computer into an API root", () => {
    const cases: Array<[string, string]> = [
      ["192.168.1.20:8080", "http://192.168.1.20:8080"],
      [" 10.0.0.5:11434 ", "http://10.0.0.5:11434"],
      ["gpu-box.local:1234", "http://gpu-box.local:1234"],
      ["gpu-box:8080", "http://gpu-box:8080"],
      ["http://192.168.1.20:8080/v1", "http://192.168.1.20:8080"],
      ["http://192.168.1.20:8080/v1/", "http://192.168.1.20:8080"],
      ["192.168.1.20:8080/", "http://192.168.1.20:8080"],
      ["https://studio.lan:1234", "https://studio.lan:1234"],
      ["[fd12::1]:8080", "http://[fd12::1]:8080"],
      ["HTTP://192.168.1.20:8080", "http://192.168.1.20:8080"],
      ["192.168.1.20:8080/v1?x=1#top", "http://192.168.1.20:8080"],
      ["http://192.168.1.20/proxy/llm/v1", "http://192.168.1.20/proxy/llm"],
    ];
    for (const [raw, baseUrl] of cases) {
      expect(normalizeNetworkServerAddress(raw), raw).toEqual({ ok: true, baseUrl });
    }
  });

  it("refuses what is not an address, with a reason to show", () => {
    for (const raw of ["", "   ", "ftp://192.168.1.20", "http://", "http://user:pw@192.168.1.20:8080", "http://[::zz]:80"]) {
      const result = normalizeNetworkServerAddress(raw);
      expect(result.ok, raw).toBe(false);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("withAssumedScheme", () => {
  it("adds http:// for this machine and the home network", () => {
    expect(withAssumedScheme("192.168.1.20:8080")).toBe("http://192.168.1.20:8080");
    expect(withAssumedScheme("gpu-box.local:1234")).toBe("http://gpu-box.local:1234");
    expect(withAssumedScheme("localhost:9931")).toBe("http://localhost:9931");
  });

  it("adds https:// for anything else and keeps a typed scheme", () => {
    expect(withAssumedScheme("api.example.com")).toBe("https://api.example.com");
    expect(withAssumedScheme("http://api.example.com")).toBe("http://api.example.com");
    expect(withAssumedScheme("https://192.168.1.20:8443")).toBe("https://192.168.1.20:8443");
  });

  it("leaves empty input empty, so the caller's default still applies", () => {
    expect(withAssumedScheme("")).toBe("");
    expect(withAssumedScheme("  ")).toBe("");
  });
});

describe("isOtherComputerOnNetworkUrl", () => {
  it("is true for private-network servers that are not this machine", () => {
    for (const url of ["http://192.168.1.20:8080", "http://10.0.0.5:11434", "http://172.20.1.2:8000",
      "http://169.254.3.4:8080", "http://gpu-box.local:1234", "http://gpu-box:8080", "http://studio.lan",
      "http://[fd12::1]:8080", "http://[fe80::1]:8080"]) {
      expect(isOtherComputerOnNetworkUrl(url), url).toBe(true);
    }
  });

  it("is false for this machine, public hosts and garbage", () => {
    for (const url of ["http://localhost:8080", "http://127.0.0.1:1234", "http://127.0.0.2:8080", "http://[::1]:8080",
      "http://0.0.0.0:8080", "http://box.localhost:8080", "https://api.openai.com", "http://8.8.8.8:8080",
      "not a url", "", undefined]) {
      expect(isOtherComputerOnNetworkUrl(url), String(url)).toBe(false);
    }
  });

  it("keeps the existing classifications as they were", () => {
    // ATO-1066: a LAN server is "this machine or the network" for request
    // shaping, but never "this machine" for this-computer advice and checks.
    const lan = "http://192.168.1.20:8080";
    expect(isLocalServerUrl(lan)).toBe(true);
    expect(isLocalProviderUrl(lan)).toBe(false);
  });
});

describe("describeOtherComputerUnreachable", () => {
  const lan = "http://192.168.1.20:8080/v1";

  it("explains a server on another computer that did not answer", () => {
    for (const error of ["fetch failed", "connect ECONNREFUSED 192.168.1.20:8080", "connect EHOSTUNREACH 192.168.1.20:8080",
      "The operation was aborted due to timeout"]) {
      const line = describeOtherComputerUnreachable(lan, error);
      expect(line, error).toContain("nothing answered at http://192.168.1.20:8080");
      expect(line).toContain("not only on 127.0.0.1");
      expect(line).toContain("firewall");
    }
  });

  it("stays out of the way when the server answered or is not on the network", () => {
    expect(describeOtherComputerUnreachable(lan, "http 401: invalid key")).toBeNull();
    expect(describeOtherComputerUnreachable(lan, "server listed no models")).toBeNull();
    expect(describeOtherComputerUnreachable("http://127.0.0.1:8080", "fetch failed")).toBeNull();
    expect(describeOtherComputerUnreachable("https://api.example.com", "fetch failed")).toBeNull();
    expect(describeOtherComputerUnreachable(undefined, "fetch failed")).toBeNull();
  });
});

describe("address classification edge cases", () => {
  it("classifies an IPv4-mapped IPv6 address by the IPv4 inside it", () => {
    // Node rewrites `[::ffff:192.168.1.20]` to `[::ffff:c0a8:114]`.
    for (const url of ["http://[::ffff:192.168.1.20]:8080", "http://[::ffff:c0a8:114]:8080", "http://[::ffff:10.0.0.5]"]) {
      expect(isOtherComputerOnNetworkUrl(url), url).toBe(true);
      expect(isLocalServerUrl(url), url).toBe(true);
    }
    for (const url of ["http://[::ffff:127.0.0.1]:8080", "http://[::ffff:7f00:2]"]) {
      expect(isOtherComputerOnNetworkUrl(url), url).toBe(false);
      expect(isLocalServerUrl(url), url).toBe(true);
    }
    expect(isLocalProviderUrl("http://[::ffff:127.0.0.1]:8080")).toBe(true);
    expect(isLocalServerUrl("http://[::ffff:8.8.8.8]")).toBe(false);
    expect(isOtherComputerOnNetworkUrl("http://[::ffff:8.8.8.8]")).toBe(false);
  });

  it("classifies other IPv6 forms that carry an IPv4 address by that address", () => {
    // IPv4-translated (::ffff:0:a.b.c.d), NAT64 well-known (64:ff9b::/96),
    // IPv4-compatible (::a.b.c.d) and 6to4 (2002:AABB:CCDD::/48), dotted
    // and in the hex form Node rewrites them to.
    for (const url of [
      "https://[::ffff:0:192.168.1.5]",
      "https://[::ffff:0:c0a8:105]",
      "https://[64:ff9b::192.168.1.5]",
      "https://[64:ff9b::c0a8:105]",
      "https://[::192.168.1.5]",
      "https://[::c0a8:105]",
      "https://[2002:c0a8:105::]",
      "https://[2002:c0a8:105:1::1]",
      "https://[2002:0a00::1]",
    ]) {
      expect(classifiableHostOf(url), url).toMatch(/^(192\.168\.1\.5|10\.0\.0\.0)$/);
      expect(isOtherComputerOnNetworkUrl(url), url).toBe(true);
    }
    expect(classifiableHostOf("https://[64:ff9b::808:808]")).toBe("8.8.8.8");
    expect(classifiableHostOf("https://[2002:808:808::]")).toBe("8.8.8.8");
    // Not an embedded address: loopback, unspecified and ordinary IPv6.
    expect(classifiableHostOf("http://[::1]")).toBe("::1");
    expect(classifiableHostOf("http://[::]")).toBe("::");
    expect(classifiableHostOf("http://[2001:db8::1]")).toBe("2001:db8::1");
    expect(classifiableHostOf("http://[64:ff9b:1::c0a8:105]")).toBe("64:ff9b:1::c0a8:105");
  });

  it("counts the Tailscale / CGNAT block 100.64.0.0/10 as the operator's network", () => {
    for (const url of ["http://100.64.0.1:8080", "http://100.100.1.2:8080", "http://100.127.255.254"]) {
      expect(isOtherComputerOnNetworkUrl(url), url).toBe(true);
    }
    for (const url of ["http://100.63.255.255", "http://100.128.0.1"]) {
      expect(isLocalServerUrl(url), url).toBe(false);
    }
  });

  it("counts private-network name suffixes as the operator's network", () => {
    for (const url of [
      "https://gpu.tail1234.ts.net",
      "https://nas.home",
      "https://gpu.localdomain",
      "http://localhost.localdomain",
      "https://gpu.corp",
      "https://wiki.intranet:8443",
    ]) {
      expect(isOtherComputerOnNetworkUrl(url), url).toBe(true);
    }
    // Only as a whole label: a public name that merely ends in the letters.
    for (const url of ["https://example.com", "https://notts.net", "https://myhome", "https://mycorp.com"]) {
      expect(isOtherComputerOnNetworkUrl(url), url).toBe(url === "https://myhome");
    }
  });

  it("classifies a nip.io / sslip.io name by the address inside it", () => {
    for (const url of [
      "https://192.168.1.5.nip.io",
      "https://app.10.0.0.7.sslip.io",
      "https://192-168-1-5.nip.io",
      "https://app-10-0-0-7.sslip.io",
      "https://c0a80105.nip.io",
      // Unreadable: the name resolves to whatever is inside, so conservatively ours.
      "https://whatever.nip.io",
      // Loopback inside a public DNS name is not "this machine" lexically.
      "http://127.0.0.1.nip.io",
    ]) {
      expect(isOtherComputerOnNetworkUrl(url), url).toBe(true);
    }
    for (const url of ["https://8.8.8.8.nip.io", "https://8-8-8-8.sslip.io", "https://08080808.nip.io"]) {
      expect(isOtherComputerOnNetworkUrl(url), url).toBe(false);
    }
  });

  it("treats the IPv6 unspecified address like 0.0.0.0: this machine", () => {
    expect(isLocalProviderUrl("http://[::]:8080")).toBe(true);
    expect(isLocalServerUrl("http://[::]:8080")).toBe(true);
    expect(isOtherComputerOnNetworkUrl("http://[::]:8080")).toBe(false);
  });
});
