/**
 * The host of a base URL in the one spelling every address classifier
 * (`isLocalProviderUrl`, `isLocalServerUrl`, `isOtherComputerOnNetworkUrl`)
 * compares against: lower-cased, IPv6 brackets removed and one trailing
 * DNS root dot removed (`localhost.` is `localhost`). `null` when the URL
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
  return host.length > 0 ? host : null;
}
