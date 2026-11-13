/**
 * The host of a base URL in the one spelling every address classifier
 * (`isLocalProviderUrl`, `isLocalServerUrl`, `isOtherComputerOnNetworkUrl`)
 * compares against: lower-cased, IPv6 brackets removed and one trailing
 * DNS root dot removed (`localhost.` is `localhost`), and an IPv4-mapped
 * IPv6 address (`[::ffff:192.168.1.20]`, which `URL` rewrites to
 * `[::ffff:c0a8:114]`) replaced by the IPv4 address inside it, so it is
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

// `URL` serializes IPv6 compressed, so the mapped form always starts `::ffff:`.
const MAPPED_DOTTED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;
const MAPPED_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/** The IPv4 address an IPv4-mapped IPv6 host (`::ffff:a.b.c.d`) carries. */
function embeddedIpv4(host: string): string | null {
  const dotted = MAPPED_DOTTED.exec(host);
  if (dotted) return dotted[1]!;
  const hex = MAPPED_HEX.exec(host);
  if (!hex) return null;
  const high = parseInt(hex[1]!, 16);
  const low = parseInt(hex[2]!, 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}
