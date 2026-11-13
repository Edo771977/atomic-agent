/**
 * The provider entry a `configure` wizard run starts from, as it is
 * written in `config.json` — and which of its key settings may follow
 * the entry to the address the wizard now points it at.
 *
 * Read from the file, not from `getConfig()`: the runtime config fills
 * every entry's `apiKey` from the environment (`OPENAI_COMPAT_API_KEY`,
 * an `apiKeyEnvVar`, ...), so "the key this entry already has" read from
 * there is often a shared variable's value. Copying that into the saved
 * entry wrote the operator's cloud key into `config.json` in clear, and
 * resolving with it handed that key to whatever server the entry now
 * names (ATO-1066).
 */

import { getConfig, readUserConfigFileSync } from "../../config/index.js";
import type { UserLlmProviderEntry } from "../../config/llm-config.js";
import {
  isOtherComputerOnNetworkUrl,
  withAssumedScheme,
} from "../../llm/provider/openai/network-server-address.js";

/** The `config.json` entry with this id, without anything filled in from the environment. */
export function storedProviderFileEntry(
  providerId: string,
): UserLlmProviderEntry | undefined {
  const path = getConfig().paths.userConfigFile;
  return readUserConfigFileSync(path)?.llm?.providers.find(
    (provider) => provider.id === providerId,
  );
}

function serverOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(withAssumedScheme(url));
    return `${parsed.protocol}//${parsed.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

/**
 * `stored` as it will be once saved with `baseUrl` (an
 * `openai-compatible` entry's new address), so key resolution sees where
 * the key would actually go. A key saved in the entry for a different
 * server does not follow it to another computer on the network: it
 * belonged to that other server, usually a cloud account, and would go
 * out in clear. `apiKeyEnvVar` does follow it — the operator named that
 * variable for this entry.
 */
export function storedEntryAtBaseUrl(
  stored: UserLlmProviderEntry,
  baseUrl: string | undefined,
): UserLlmProviderEntry {
  if (stored.kind !== "openai-compatible" || !baseUrl) return stored;
  const moved = { ...stored, baseUrl };
  if (
    moved.apiKey &&
    isOtherComputerOnNetworkUrl(baseUrl) &&
    serverOf(stored.baseUrl) !== serverOf(baseUrl)
  ) {
    const { apiKey: _dropped, ...rest } = moved;
    return rest;
  }
  return moved;
}
