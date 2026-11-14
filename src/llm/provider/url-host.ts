/**
 * The host of a base URL in the one spelling every address classifier
 * (`isLocalProviderUrl`, `isLocalServerUrl`, `isOtherComputerOnNetworkUrl`)
 * compares against: lower-cased, IPv6 brackets removed and one trailing
 * DNS root dot removed (`localhost.` is `localhost`), and an IPv6 address
 * that embeds an IPv4 one (IPv4-mapped `[::ffff:192.168.1.20]`, which
 * `URL` rewrites to `[::ffff:c0a8:114]`, and the other forms
 * `embeddedIpv4` lists) replaced by the IPv4 address inside it, so it is
 * classified as that address. `null` when the URL
 * does not parse or has no host. Classifiers that read the host their own
 * way disagreed about the same URL, and the shared OpenAI key followed the
 * most permissive answer.
 */
export function classifiableHostOf(url: string | undefined): string | null {
  if (!url) return null;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host.length === 0) return null;
  return embeddedIpv4(host) ?? host;
}

/**
 * The IPv4 address an IPv6 host carries, for the forms that embed one:
 * IPv4-mapped `::ffff:a.b.c.d`, IPv4-translated `::ffff:0:a.b.c.d`, the
 * NAT64 well-known prefix `64:ff9b::/96`, IPv4-compatible `::a.b.c.d`
 * (deprecated; not `::` or `::1`) and 6to4 `2002:AABB:CCDD::/48`. Read
 * from the expanded address, so the dotted and the hex spelling `URL`
 * rewrites them to agree. `null` for anything else.
 */
function embeddedIpv4(host: string): string | null {
  const g = expandIpv6(host);
  if (g === null) return null;
  const zero = (from: number, to: number) => g.slice(from, to).every((part) => part === 0);
  const v4 = (high: number, low: number) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  if (zero(0, 5) && g[5] === 0xffff) return v4(g[6]!, g[7]!);
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6]!, g[7]!);
  if (zero(0, 6) && g[6] !== 0) return v4(g[6]!, g[7]!);
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!);
  return null;
}

/** The eight 16-bit groups of an IPv6 address (a dotted IPv4 tail allowed), or `null`. */
function expandIpv6(host: string): number[] | null {
  if (!host.includes(":")) return null;
  let text = host;
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail) {
    const b = tail.slice(1).map(Number);
    if (b.some((part) => part > 255)) return null;
    text = `${text.slice(0, tail.index)}${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part.length === 0 ? [] : part.split(":"));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  if (!groups.every((part) => /^[0-9a-f]{1,4}$/.test(part))) return null;
  return groups.map((part) => parseInt(part, 16));
}

/**
 * `true` when `url` points at this machine: `localhost` and `*.localhost`,
 * the whole 127/8 block, `::1`, and the unspecified `0.0.0.0` / `::`
 * (which connect to this machine). Any spelling `classifiableHostOf`
 * accepts, IPv4-mapped included.
 */
export function isLoopbackUrl(url: string | undefined): boolean {
  const host = classifiableHostOf(url);
  if (host === null) return false;
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "::" ||
    host === "0.0.0.0" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}
