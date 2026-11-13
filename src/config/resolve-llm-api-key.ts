import { isOtherComputerOnNetworkUrl } from "../llm/provider/openai/network-server-address.js";
import { isLoopbackUrl } from "../llm/provider/url-host.js";
import type { UserLlmProviderEntry } from "./llm-config.js";

/**
 * Resolve API keys for provider registry entries. File-stored `apiKey`
 * wins; otherwise well-known env vars are consulted.
 */
export function resolveLlmProviderApiKey(
  entry: UserLlmProviderEntry,
): string | undefined {
  if (entry.apiKey && entry.apiKey.length > 0) {
    return entry.apiKey;
  }
  // Entries created from a known-service preset carry their own env var
  // (`GROQ_API_KEY`, `NOUS_API_KEY`, ...). It is authoritative, without
  // a fallback to the shared per-kind variables: falling through would
  // recreate the wrong-key-for-this-endpoint pairing presets exist to
  // prevent (#69), and keyless local servers (LM Studio) rely on the
  // `undefined` here to send requests without an Authorization header.
  if (entry.apiKeyEnvVar && entry.apiKeyEnvVar.length > 0) {
    const key = process.env[entry.apiKeyEnvVar];
    return key && key.length > 0 ? key : undefined;
  }
  if (entry.kind === "openrouter") {
    const key = process.env.OPENROUTER_API_KEY;
    return key && key.length > 0 ? key : undefined;
  }
  if (entry.kind === "aimlapi") {
    const key = process.env.AIMLAPI_API_KEY;
    return key && key.length > 0 ? key : undefined;
  }
  if (entry.kind === "gemini") {
    const key = process.env.GEMINI_API_KEY;
    return key && key.length > 0 ? key : undefined;
  }
  if (
    entry.kind === "openai-compatible" ||
    entry.kind === "qwen-openai-compatible"
  ) {
    // The shared variables usually hold the operator's real OpenAI key:
    // never as a Bearer over plain http:// off this machine, nor to
    // another computer on the network (ATO-1066). An explicit
    // `apiKeyEnvVar` above, even one naming OPENAI_API_KEY, is the
    // operator's own choice and is honoured.
    if (!maySendSharedOpenAiKey(entry.baseUrl)) return undefined;
    return sharedOpenAiKey()?.value;
  }
  return undefined;
}

/** The shared per-kind variables, in the order they are read. */
const SHARED_OPENAI_KEY_VARS = [
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_API_KEY",
  "ATOMIC_AGENT_OPENAI_API_KEY",
] as const;

/**
 * The shared OpenAI-compatible key and the variable it came from, read
 * with `??` semantics: the first variable that is set wins, even empty
 * (an empty one means "no key").
 */
function sharedOpenAiKey(): { readonly name: string; readonly value: string } | undefined {
  for (const name of SHARED_OPENAI_KEY_VARS) {
    const value = process.env[name];
    if (value === undefined) continue;
    return value.length > 0 ? { name, value } : undefined;
  }
  return undefined;
}

/**
 * Whether the shared OPENAI_* key may go to `baseUrl`. Those variables
 * usually hold the operator's real OpenAI key, so it goes only where it
 * cannot be read on the way or by the wrong party: an https:// endpoint
 * (the default endpoint, when no `baseUrl` is set, is https) or plain
 * http:// to this machine. Plain http:// to any other host (a public IP,
 * a box on the LAN) and a server on another computer on the network, over
 * either scheme (ATO-1066), get no shared key; an entry that wants one
 * there sets `apiKey` or `apiKeyEnvVar`.
 */
function maySendSharedOpenAiKey(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined || baseUrl.trim().length === 0) return true;
  if (isOtherComputerOnNetworkUrl(baseUrl)) return false;
  let protocol: string;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    return false;
  }
  if (protocol === "https:") return true;
  return protocol === "http:" && isLoopbackUrl(baseUrl);
}
