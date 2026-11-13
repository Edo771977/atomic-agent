import { classifiableHostOf } from "../url-host.js";

/**
 * Whether an OpenAI-compatible base URL points at a server on this
 * machine or the local network (llama-server, vLLM, LM Studio and the
 * like): loopback, RFC 1918, link-local and CGNAT/Tailscale (100.64/10) IPv4, IPv6 unique-local and
 * link-local, own-network names (`.local`, `.lan`, `.internal`,
 * `.home.arpa`, `.home`, `.localdomain`, `.corp`, `.intranet`, Tailscale
 * `.ts.net`), nip.io / sslip.io names judged by the address they spell,
 * and single-label hosts. Lexical only: no DNS lookup is made, so a public
 * name that resolves to a private address is not recognised. Such servers render the chat template themselves
 * and take its arguments (`chat_template_kwargs`); public endpoints may
 * reject a field they do not know, so they are never treated as local.
 */
export function isLocalServerUrl(url: string | undefined): boolean {
  const host = classifiableHostOf(url);
  if (host === null) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0" || host === "::") return true;
  const v4 = host.split(".");
  if (v4.length === 4 && v4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    const [a, b] = v4.map(Number) as [number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) ||
      // Carrier-grade NAT, 100.64.0.0/10: Tailscale gives every device of
      // the operator's tailnet an address here.
      (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(":")) return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
  if (!host.includes(".")) return true;
  const wildcard = WILDCARD_DNS_SUFFIXES.find((suffix) => host.endsWith(suffix));
  if (wildcard) {
    // `192.168.1.5.nip.io` resolves to 192.168.1.5: judge it as that
    // address, and a name with no readable address as the operator's own.
    const inside = wildcardDnsIpv4(host.slice(0, -wildcard.length));
    return inside === null || isLocalServerUrl(`http://${inside}`);
  }
  return OWN_NETWORK_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Name suffixes that only resolve inside the operator's own network:
 * mDNS, router and intranet conventions, and Tailscale MagicDNS
 * (`<device>.<tailnet>.ts.net`, which answers with a 100.64/10 address).
 */
const OWN_NETWORK_SUFFIXES = [
  ".local", ".lan", ".internal", ".home.arpa", ".home", ".localdomain", ".corp", ".intranet", ".ts.net",
] as const;

/** Public wildcard DNS services whose names spell the address they resolve to. */
const WILDCARD_DNS_SUFFIXES = [".nip.io", ".sslip.io"] as const;

/**
 * The IPv4 address a nip.io / sslip.io name spells before its suffix, in
 * any of the services' forms (`app.10.0.0.7`, `app-10-0-0-7`,
 * `app-0a000007`), or `null` when none reads.
 */
function wildcardDnsIpv4(prefix: string): string | null {
  const labels = prefix.split(".");
  const dotted = labels.slice(-4);
  if (dotted.length === 4 && dotted.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return dotted.join(".");
  }
  const last = labels[labels.length - 1] ?? "";
  const dashed = /(?:^|-)(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})$/.exec(last);
  if (dashed && dashed.slice(1).every((part) => Number(part) <= 255)) return dashed.slice(1).join(".");
  const hex = /(?:^|-)([0-9a-f]{8})$/.exec(last);
  if (hex) {
    const value = parseInt(hex[1]!, 16);
    return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
  }
  return null;
}
