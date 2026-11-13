import type { AtomicAgentConfig } from "../../config/index.js";
import { runGrammarSmoke } from "../../llm/grammar/grammar-smoke.js";
import type { ModelProfile } from "../../llm/model-profile.js";
import type { CompletionRequest, CompletionResult } from "../../llm/provider/completion-types.js";
import type { LlmProviderConfigEntry } from "../../llm/provider/index.js";
import { readLaunchRecord, readRunningPid } from "../../local-llm/index.js";
import { resolveServerTemplatePolicy } from "../../llm/server-template-policy.js";
import type { LocalGrammarProbe } from "../../tools/fusion/local-grammar-smoke.js";
import type { SlotOccupancy } from "../../tools/fusion/worker-result.js";
import { workerStepToolNames } from "../../tools/fusion/worker-tool-policy.js";

export interface FusionFormatCheckDeps {
  /** Live: the config the operator may change between turns. */
  getConfig: () => AtomicAgentConfig;
  /** The configured provider entries (`resolveLlmConfig(...).providers`). */
  providers: () => readonly Pick<LlmProviderConfigEntry, "id" | "kind" | "url">[];
  /** One unary completion on a configured provider. */
  complete: (providerId: string, request: CompletionRequest) => Promise<CompletionResult>;
  /** The step's base grammar, read live (MCP refreshes rebuild it). */
  getGrammar: () => string;
  /**
   * The step's tool descriptor names, read live (`effectiveToolDescriptors`):
   * narrowed to a worker's (`workerStepToolNames`) for the check's grammar.
   * Absent: the grammar admits `reply` alone.
   */
  getToolNames?: () => readonly string[];
  /** The main local server's live profile and model id. */
  getProfile: () => ModelProfile;
  getModelId: () => string | null;
  /**
   * Which launch of the server answers: a new value is a new server (a
   * restart, an upgrade) and asks afresh. Defaults to
   * {@link managedServerGeneration}.
   */
  getServerGeneration?: () => string | null;
  /**
   * The main local server's `/slots` load, `null` when unreadable. A
   * server with every slot working skips the check rather than queue it.
   */
  slotOccupancy?: () => Promise<SlotOccupancy | null>;
}

/**
 * The managed daemon's launch, as `<pid>@<launchedAt>` from its launch
 * record; `null` for an external server, or when no record matches the
 * live pid. Read per check: the daemon can restart between fan-outs.
 */
export function managedServerGeneration(config: AtomicAgentConfig): string | null {
  if (config.localModels.mode !== "managed") return null;
  const dataDir = config.paths.localModelsDataDir;
  const record = readLaunchRecord(dataDir, readRunningPid(dataDir));
  return record === null ? null : `${record.pid}@${record.launchedAt}`;
}

/**
 * The format-check probe for one fusion leg (`local-grammar-smoke.ts`),
 * or `undefined` for a leg it cannot ask honestly: anything but a
 * `llama-server` entry (a cloud leg), and a llama-server entry on a
 * second local server, whose profile the runtime does not track — the
 * same rule `probeLocalHealthFor` follows. The probe sends its one
 * completion through the leg's own provider (so its key, URL and
 * server-template rendering are the worker's), and its cache key is the
 * server URL, the model id, the profile id and the server's launch
 * generation at the time of the check (`external` when nothing tells
 * one launch from the next: the kept failure's time limit covers that
 * case). An unknown model id gives no key, so nothing is kept.
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
    const modelId = deps.getModelId();
    const generation =
      (deps.getServerGeneration ?? (() => managedServerGeneration(deps.getConfig())))() ??
      "external";
    const key =
      modelId === null ? null : [normalise(main), modelId, profile.id, generation].join("\u0000");
    const slots = deps.slotOccupancy;
    return {
      key,
      server: normalise(main),
      ...(slots === undefined
        ? {}
        : {
            allSlotsBusy: async () => {
              const occupancy = await slots();
              return occupancy !== null && occupancy.busy >= occupancy.total;
            },
          }),
      run: (signal) =>
        runGrammarSmoke({
          profile,
          baseGrammar: deps.getGrammar(),
          serverTemplate: resolveServerTemplatePolicy(deps.getConfig().localModels, profile),
          thinking: deps.getConfig().localModels.thinking,
          ...(deps.getToolNames === undefined
            ? {}
            : { toolNames: workerStepToolNames(deps.getToolNames()) }),
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
