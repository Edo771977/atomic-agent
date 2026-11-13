import { createHash } from "node:crypto";
import type { LlmProviderConfigEntry } from "../../llm/provider/registry/provider-types.js";

/** Safe endpoint identity: never retain credentials, query tokens or fragments. */
function endpoint(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = new URL(value);
    // Queries can also choose a proxy/deployment; do not guess their meaning.
    if (parsed.search !== "" || !["http:", "https:"].includes(parsed.protocol)) return undefined;
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch { return undefined; }
}

/** Configured request identity only, not attestation of a gateway's served model.
 * Unknown adapters, auto selectors, CLI arguments and external local servers do
 * not provide a stable request-model identity here and remain insufficient.
 */
export function configuredFusionRoutingIdentity(
  entry: LlmProviderConfigEntry | undefined,
  local?: { mode: "external" | "managed"; url: string; configuredModelId: string | null; liveModelId: string | null },
): string | undefined {
  if (entry === undefined) return undefined;
  let model: string | undefined;
  let address: string | undefined;
  if (entry.kind === "llama-server") {
    if (local?.mode !== "managed" || !local.configuredModelId || local.liveModelId !== local.configuredModelId) return undefined;
    address = endpoint(entry.url ?? local.url);
    if (address !== endpoint(local.url)) return undefined;
    model = local.liveModelId;
  } else {
    if (!["openai-compatible", "qwen-openai-compatible", "openrouter", "aimlapi", "gemini"].includes(entry.kind)) return undefined;
    model = entry.defaultChatModel;
    if (!model || /(?:^|\/)auto(?:$|:)/i.test(model)) return undefined;
    address = entry.baseUrl === undefined && ["openrouter", "aimlapi", "gemini"].includes(entry.kind)
      ? `builtin:${entry.kind}` : endpoint(entry.baseUrl);
  }
  if (address === undefined) return undefined;
  return createHash("sha256").update(JSON.stringify(["fusion-request-identity-v1", entry.id, entry.kind, address, model])).digest("hex");
}
