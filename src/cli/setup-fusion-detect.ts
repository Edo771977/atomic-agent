import { join, resolve } from "node:path";

import {
  getUserConfigPath,
  loadDotenvFromStateDir,
  readUserConfigSnapshotSync,
  type UserConfigFile,
} from "../config/index.js";
import { SUBSCRIPTION_CLIS, type SubscriptionCliName } from "../config/llm-config.js";
import {
  dotenvKeyForProviderKind,
  readLlmBlockOrDefault,
} from "../config/llm-provider-commands.js";
import { providerKeyStatus } from "../llm/provider/provider-key.js";
import {
  checkSubscriptionCli,
  configuredSubscriptionBinPath,
  registerBuiltInCliAdapters,
  resolveCliAdapter,
  type SubscriptionCliStatusReport,
} from "../llm/provider/subscription-cli/index.js";
import type {
  FusionSetupFacts,
  FusionSetupProviderFact,
} from "../llm/run-mode/fusion-setup-plan.js";
import { recommendModelTiers } from "../local-llm/catalog/model-upgrade.js";
import { probeMachineForModels } from "../local-llm/backend/machine-for-models.js";
import {
  isModelDownloaded,
  listLocalModels,
  setCustomLocalModels,
} from "../local-llm/index.js";

/**
 * Gather what `setup fusion` plans from, without writing anything: the
 * config is read (not created), `.env` is loaded so a key there counts,
 * and the CLI check never runs a turn. Every probe is injectable.
 */
export interface FusionDetectDeps {
  readonly checkCli?: (
    cli: SubscriptionCliName,
    binPath: string | undefined,
  ) => Promise<Pick<SubscriptionCliStatusReport, "state" | "fix">>;
  /** Ids of catalog chat models on disk under `dataDir`. */
  readonly downloadedModelIds?: (dataDir: string) => string[];
  /** The catalog's pick for this machine (null when none fits). */
  readonly recommendModelId?: (dataDir: string, file: UserConfigFile) => Promise<string | null>;
  readonly claudeCliDefaultModel?: () => string | null;
  /** External mode: does a llama-server answer `/health` at `url`? */
  readonly probeExternal?: (url: string) => Promise<boolean>;
  /** Load `<stateDir>/.env` into the environment (default: yes). */
  readonly loadDotenv?: (stateDir: string) => void;
}

function defaultDownloadedIds(dataDir: string): string[] {
  return listLocalModels()
    .filter((def) => isModelDownloaded(dataDir, def))
    .map((def) => def.id);
}

async function defaultRecommend(dataDir: string, file: UserConfigFile): Promise<string | null> {
  const machine = await probeMachineForModels({
    dataDir,
    engine: file.localModels.managed.engine,
    configuredDevice: file.localModels.managed.device,
  });
  const tiers = recommendModelTiers(machine);
  return (tiers.balanced ?? tiers.quality ?? tiers.fast)?.id ?? null;
}

async function defaultProbeExternal(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function defaultCheckCli(cli: SubscriptionCliName, binPath: string | undefined) {
  registerBuiltInCliAdapters();
  return checkSubscriptionCli(resolveCliAdapter(cli), binPath ? { binPath } : {});
}

function defaultClaudeModel(): string | null {
  registerBuiltInCliAdapters();
  return resolveCliAdapter("claude").defaultChatModel || null;
}

const CREDENTIAL_KINDS = new Set(["openrouter", "aimlapi", "gemini", "openai-compatible"]);

export async function detectFusionSetup(
  stateDir: string,
  deps: FusionDetectDeps = {},
): Promise<FusionSetupFacts> {
  (deps.loadDotenv ?? ((dir) => { loadDotenvFromStateDir(dir); }))(stateDir);
  // The snapshot read names the file in a validation error (a missing
  // file reads as the defaults); the caller prints it and stops.
  const file = readUserConfigSnapshotSync(getUserConfigPath(stateDir)).config;
  setCustomLocalModels(file.localModels.customModels);
  const llm = readLlmBlockOrDefault(file);

  const providers: FusionSetupProviderFact[] = llm.providers.map((p) => ({
    id: p.id,
    kind: p.kind,
    keyState: providerKeyStatus(p).state,
    envVar:
      p.apiKeyEnvVar ||
      (CREDENTIAL_KINDS.has(p.kind)
        ? dotenvKeyForProviderKind(p.kind as Parameters<typeof dotenvKeyForProviderKind>[0])
        : null),
    subscriptionCli: p.subscriptionCli?.cli ?? null,
  }));

  const wanted = new Set<SubscriptionCliName>(["claude"]);
  for (const p of providers) {
    if ((SUBSCRIPTION_CLIS as readonly string[]).includes(p.subscriptionCli ?? "")) {
      wanted.add(p.subscriptionCli as SubscriptionCliName);
    }
  }
  const checkCli = deps.checkCli ?? defaultCheckCli;
  const subscriptionClis: Record<string, { state: SubscriptionCliStatusReport["state"]; fix: string | null }> = {};
  await Promise.all(
    [...wanted].map(async (cli) => {
      const r = await checkCli(cli, configuredSubscriptionBinPath(llm.providers, cli));
      subscriptionClis[cli] = { state: r.state, fix: r.fix };
    }),
  );

  const managed = file.localModels.managed;
  const dataDir = managed.dataDirOverride
    ? resolve(managed.dataDirOverride)
    : join(stateDir, "models");
  const mode = file.localModels.mode === "managed" ? "managed" : "external";
  const url = mode === "managed" ? `http://127.0.0.1:${managed.port}` : file.localModels.url;
  const externalAnswers =
    mode === "external" ? await (deps.probeExternal ?? defaultProbeExternal)(url) : null;
  // Models on disk count in either mode: on an external server that does
  // not answer, they are what `models use` can switch to.
  const downloadedModelIds = (deps.downloadedModelIds ?? defaultDownloadedIds)(dataDir);
  const managedModelOnDisk =
    managed.modelId !== null && downloadedModelIds.includes(managed.modelId);
  const recommendedModelId =
    downloadedModelIds.length === 0 && externalAnswers !== true
      ? await (deps.recommendModelId ?? defaultRecommend)(dataDir, file)
      : null;

  return {
    stateDir,
    activeTextProvider: llm.activeTextProvider,
    providers,
    runMode: llm.runMode,
    subscriptionClis,
    claudeCliDefaultModel: (deps.claudeCliDefaultModel ?? defaultClaudeModel)(),
    local: {
      mode,
      url,
      externalAnswers,
      managedModelId: managed.modelId,
      managedModelOnDisk,
      downloadedModelIds,
      recommendedModelId,
    },
  };
}
