import type { AtomicAgentConfig } from "../../config/index.js";
import { runGrammarSmoke } from "../../llm/grammar/grammar-smoke.js";
import type { ModelProfile } from "../../llm/model-profile.js";
import type { CompletionRequest, CompletionResult } from "../../llm/provider/completion-types.js";
import type { LlmProviderConfigEntry } from "../../llm/provider/index.js";
import { resolveServerTemplatePolicy } from "../../llm/server-template-policy.js";
import type { LocalGrammarProbe } from "../../tools/fusion/local-grammar-smoke.js";

export interface FusionFormatCheckDeps {
  /** Live: the config the operator may change between turns. */
  getConfig: () => AtomicAgentConfig;
  /** The configured provider entries (`resolveLlmConfig(...).providers`). */
  providers: () => readonly Pick<LlmProviderConfigEntry, "id" | "kind" | "url">[];
  /** One unary completion on a configured provider. */
  complete: (providerId: string, request: CompletionRequest) => Promise<CompletionResult>;
  /** The step's base grammar, read live (MCP refreshes rebuild it). */
  getGrammar: () => string;
  /** The main local server's live profile and model id. */
  getProfile: () => ModelProfile;
  getModelId: () => string | null;
}

/**
 * The format-check probe for one fusion leg (`local-grammar-smoke.ts`),
 * or `undefined` for a leg it cannot ask honestly: anything but a
 * `llama-server` entry (a cloud leg), and a llama-server entry on a
 * second local server, whose profile the runtime does not track — the
 * same rule `probeLocalHealthFor` follows. The probe sends its one
 * completion through the leg's own provider (so its key, URL and
 * server-template rendering are the worker's), and its cache key is the
 * server URL, the model id and the profile id at the time of the check.
 */
export function createFusionFormatProbeFor(
  deps: FusionFormatCheckDeps,
): (providerId: string) => LocalGrammarProbe | undefined {
  return (providerId) => {
    const entry = deps.providers().find((p) => p.id === providerId);
    if (entry === undefined || entry.kind !== "llama-server") return undefined;
    const main = deps.getConfig().localModels.url;
    if (entry.url !== undefined && normalise(entry.url) !== normalise(main)) return undefined;
    const profile = deps.getProfile();
    const key = [normalise(main), deps.getModelId() ?? "?", profile.id].join("\u0000");
    return {
      key,
      run: (signal) =>
        runGrammarSmoke({
          profile,
          baseGrammar: deps.getGrammar(),
          serverTemplate: resolveServerTemplatePolicy(deps.getConfig().localModels, profile)
            .useServerTemplate,
          complete: (request) => deps.complete(providerId, request),
          partition: providerId,
          ...(signal === undefined ? {} : { signal }),
        }),
    };
  };
}

function normalise(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
