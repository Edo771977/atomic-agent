import {
  normalizeNetworkServerAddress,
  withAssumedScheme,
} from "../../llm/provider/openai/network-server-address.js";

/**
 * Why the typed base URL cannot be saved, or `null` when it can (empty
 * means the default endpoint). ATO-1066: `withAssumedScheme` alone let
 * `user:pw@10.0.0.5`, `?token=…#frag` and trailing words through, and
 * the stored entry then carried a password, a query the call sites
 * append `/v1/...` after, or a host that is not the one typed. The
 * address is only scheme, host, port and path.
 */
export function baseUrlLineError(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  if (/\s/.test(trimmed)) {
    return "The address has a space in it. Type only the address, for example 192.168.1.20:8080.";
  }
  if (trimmed.includes("?") || trimmed.includes("#")) {
    return "Leave out the ?… and #… part; type only the address and path, for example http://192.168.1.20:8080/v1.";
  }
  const checked = normalizeNetworkServerAddress(withAssumedScheme(trimmed));
  return checked.ok ? null : checked.reason;
}
