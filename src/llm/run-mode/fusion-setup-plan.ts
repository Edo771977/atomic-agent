import type { UserLlmProviderEntry } from "../../config/llm-config.js";
import {
  LOCAL_PROVIDER_KIND,
  type UserLlmFusionConfig,
  type UserLlmRunModeConfig,
} from "../../config/llm-run-mode-config.js";
import { SUBSCRIPTION_CLI_KIND } from "../../config/provider-auth-mode.js";
import type { ProviderKeyStatus } from "../provider/provider-key.js";
import type { SubscriptionCliState } from "../provider/subscription-cli/subscription-cli-status.js";

/**
 * `atomic-agent setup fusion` (and any frontend that offers the same
 * preset): from what this machine has, propose "a strong model plans, the
 * local model executes" and the settings that make the pattern work.
 *
 * Pure: the caller gathers the facts (config, key status, CLI status,
 * models on disk) and writes the result through
 * `applyFusionSetupInConfig`. Nothing here reads a secret; a provider is
 * described by its key *state* and the variable that would hold it.
 */

export interface FusionSetupProviderFact {
  readonly id: string;
  readonly kind: string;
  readonly keyState: ProviderKeyStatus["state"];
  /** Where its key is read from (`OPENROUTER_API_KEY`, ...), never the value. */
  readonly envVar: string | null;
  /** `subscriptionCli.cli` of a subscription entry, else null. */
  readonly subscriptionCli: string | null;
}

export interface FusionSetupCliFact {
  readonly state: SubscriptionCliState;
  /** The command that fixes it (install, sign in), or null. */
  readonly fix: string | null;
}

export interface FusionSetupFacts {
  readonly stateDir: string;
  readonly activeTextProvider: string;
  readonly providers: readonly FusionSetupProviderFact[];
  readonly runMode: UserLlmRunModeConfig | undefined;
  /** Status per subscription CLI that was checked (`claude` always). */
  readonly subscriptionClis: Readonly<Record<string, FusionSetupCliFact>>;
  /** `defaultChatModel` a new Claude Code entry gets (the adapter's own default). */
  readonly claudeCliDefaultModel: string | null;
  readonly local: {
    readonly mode: "managed" | "external";
    readonly url: string;
    /** External mode: whether a server answered at `url` (null when not probed). */
    readonly externalAnswers: boolean | null;
    readonly managedModelId: string | null;
    readonly managedModelOnDisk: boolean;
    readonly downloadedModelIds: readonly string[];
    /** The catalog's pick for this machine, when the managed engine has nothing on disk. */
    readonly recommendedModelId: string | null;
  };
  /**
   * Enum values a newer build wrote that this build set aside on read
   * (dotted key → the value on disk). Read as unset, but the person's:
   * never filled over.
   */
  readonly setAside?: Readonly<Record<string, string>>;
}

/** Defaults this preset writes; documented in src/cli/README.md. */
export const FUSION_SETUP_AUTO_REPLAN = 1;
export const FUSION_SETUP_TURN_BUDGET_USD = 1;

export interface FusionSetupLeg {
  readonly providerId: string;
  readonly kind: string;
  /** Billed per token: a dollar cap and the advisor's dollar cap apply. */
  readonly priced: boolean;
  /** One line on why this leg was picked. */
  readonly why: string;
}

export interface FusionSetupChange {
  /** Dotted config key. */
  readonly key: string;
  readonly from: unknown;
  readonly to: unknown;
}

export interface FusionSetupWrite {
  /** A provider entry to add (a signed-in Claude Code with no entry yet). */
  readonly addProvider?: UserLlmProviderEntry;
  readonly activeTextProvider: string;
  /** Merged over the stored `llm.runMode.fusion`. */
  readonly fusion: Partial<UserLlmFusionConfig>;
}

export type FusionSetupPlan =
  | {
      readonly ok: true;
      readonly orchestrator: FusionSetupLeg;
      readonly worker: FusionSetupLeg;
      /** What the write changes; empty means everything is already set. */
      readonly changes: readonly FusionSetupChange[];
      /** Keys already at the preset's value, or set by the person and kept. */
      readonly unchanged: readonly string[];
      /** Values a newer build wrote that this build cannot read; left as they are. */
      readonly keptNewer: readonly { readonly key: string; readonly value: string }[];
      readonly write: FusionSetupWrite;
      readonly tips: readonly string[];
    }
  | {
      readonly ok: false;
      readonly orchestrator: FusionSetupLeg | null;
      readonly worker: FusionSetupLeg | null;
      /** Each a sentence that says what to do. */
      readonly problems: readonly string[];
    };

const CLOUD_KEY_HINT = "or add it in the TUI: Manage › LLM › Cloud";

function isLocal(p: FusionSetupProviderFact): boolean {
  return p.kind === LOCAL_PROVIDER_KIND;
}

function isSubscription(p: FusionSetupProviderFact): boolean {
  return p.kind === SUBSCRIPTION_CLI_KIND && p.subscriptionCli !== null;
}

function cliReady(facts: FusionSetupFacts, cli: string | null): boolean {
  return cli !== null && facts.subscriptionClis[cli]?.state === "ready";
}

/** A cloud entry that can answer now: a keyed API, or a signed-in CLI. */
function orchestratorReady(facts: FusionSetupFacts, p: FusionSetupProviderFact): boolean {
  if (isLocal(p)) return false;
  if (isSubscription(p)) return cliReady(facts, p.subscriptionCli);
  return p.keyState === "present";
}

function leg(p: { id: string; kind: string }, why: string): FusionSetupLeg {
  return {
    providerId: p.id,
    kind: p.kind,
    priced: p.kind !== LOCAL_PROVIDER_KIND && p.kind !== SUBSCRIPTION_CLI_KIND,
    why,
  };
}

function freeId(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

function pickOrchestrator(facts: FusionSetupFacts):
  | { leg: FusionSetupLeg; addProvider?: UserLlmProviderEntry }
  | { problems: string[] } {
  const stored = facts.runMode?.fusion?.orchestratorProvider;
  const byId = (id: string | undefined) => facts.providers.find((p) => p.id === id);
  const storedEntry = byId(stored);
  if (storedEntry && orchestratorReady(facts, storedEntry)) {
    return { leg: leg(storedEntry, "the orchestrator already set for fusion") };
  }
  const keyed = facts.providers.filter((p) => !isSubscription(p) && orchestratorReady(facts, p));
  const active = keyed.find((p) => p.id === facts.activeTextProvider);
  const firstKeyed = active ?? keyed[0];
  if (firstKeyed) {
    return { leg: leg(firstKeyed, "a configured cloud provider with a key") };
  }
  const sub = facts.providers.find((p) => isSubscription(p) && orchestratorReady(facts, p));
  if (sub) return { leg: leg(sub, "a configured subscription CLI that is signed in") };
  if (cliReady(facts, "claude")) {
    const id = freeId("claude-cli", facts.providers.map((p) => p.id));
    const addProvider: UserLlmProviderEntry = {
      id,
      kind: SUBSCRIPTION_CLI_KIND,
      ...(facts.claudeCliDefaultModel ? { defaultChatModel: facts.claudeCliDefaultModel } : {}),
      subscriptionCli: { cli: "claude" },
    };
    return {
      leg: leg(addProvider, "your signed-in Claude Code subscription (new provider entry)"),
      addProvider,
    };
  }
  const problems: string[] = [];
  for (const p of facts.providers) {
    if (isLocal(p) || isSubscription(p)) continue;
    if (p.keyState === "missing") {
      const where = p.envVar
        ? `put ${p.envVar}=… in ${facts.stateDir}/.env`
        : `set its key`;
      problems.push(`${p.id} has no API key: ${where}, ${CLOUD_KEY_HINT}.`);
    }
  }
  for (const p of facts.providers.filter(isSubscription)) {
    const st = facts.subscriptionClis[p.subscriptionCli ?? ""];
    if (st && st.state !== "ready" && p.subscriptionCli !== "claude") {
      problems.push(`${p.id}: its CLI is not ready${st.fix ? `; run: ${st.fix}` : ""}.`);
    }
  }
  const claude = facts.subscriptionClis.claude;
  if (claude?.state === "signed_out") {
    problems.push(`Claude Code is installed but not signed in; run: ${claude.fix ?? "claude"}.`);
  } else if (claude?.state === "missing") {
    problems.push(`Claude Code is not installed; to use your subscription, install it (${claude.fix ?? "see claude.ai"}) and sign in.`);
  } else if (claude?.state === "unknown") {
    problems.push("Claude Code is installed but its login could not be checked; see: atomic-agent providers status.");
  }
  problems.unshift(
    `No strong model to orchestrate. Add a cloud provider with an API key (${CLOUD_KEY_HINT.replace(/^or /, "")}), or sign in to Claude Code.`,
  );
  return { problems };
}

function pickWorker(facts: FusionSetupFacts): { leg: FusionSetupLeg } | { problems: string[] } {
  const stored = facts.providers.find(
    (p) => p.id === facts.runMode?.fusion?.workerProvider && isLocal(p),
  );
  const entry = stored ?? facts.providers.find(isLocal);
  if (!entry) {
    return {
      problems: [
        `No local provider entry (kind "${LOCAL_PROVIDER_KIND}") to run the workers; add one in the TUI: Manage › LLM.`,
      ],
    };
  }
  const local = facts.local;
  if (local.mode === "external" && local.externalAnswers === true) {
    return { leg: leg(entry, `your own llama-server at ${local.url} (keep it running)`) };
  }
  if (local.mode === "managed" && local.managedModelId !== null && local.managedModelOnDisk) {
    return { leg: leg(entry, `the managed local engine serving ${local.managedModelId}`) };
  }
  const have = local.downloadedModelIds[0];
  const why =
    local.mode === "external"
      ? `No local model server answers at ${local.url}.`
      : `The managed local model${local.managedModelId ? ` (${local.managedModelId})` : ""} is not on disk.`;
  if (have) {
    return {
      problems: [`${why} Use one you have with the built-in engine: atomic-agent models use ${have}`],
    };
  }
  if (local.recommendedModelId) {
    return {
      problems: [
        `${why} No local model on disk for the workers. Download the one recommended for this machine, then run this again:\n    atomic-agent models pull ${local.recommendedModelId} --background\n    atomic-agent models use ${local.recommendedModelId}`,
      ],
    };
  }
  return {
    problems: [
      "No local model on disk, and none in the catalog fits this machine comfortably; see: atomic-agent models recommend",
    ],
  };
}

/** Opt-ins the person asked for on top of the preset. */
export interface FusionSetupOptions {
  /** `judge: "on"`. */
  readonly judge?: boolean;
  /** `isolation: "worktree"`. */
  readonly isolation?: boolean;
}

/** Propose the two legs and the preset's settings, or say what is missing. */
export function planFusionSetup(
  facts: FusionSetupFacts,
  options: FusionSetupOptions = {},
): FusionSetupPlan {
  const o = pickOrchestrator(facts);
  const w = pickWorker(facts);
  if ("problems" in o || "problems" in w) {
    return {
      ok: false,
      orchestrator: "leg" in o ? o.leg : null,
      worker: "leg" in w ? w.leg : null,
      problems: [...("problems" in o ? o.problems : []), ...("problems" in w ? w.problems : [])],
    };
  }
  const orchestrator = o.leg;
  const worker = w.leg;
  const stored = facts.runMode?.fusion ?? {};
  const changes: FusionSetupChange[] = [];
  const unchanged: string[] = [];
  const keptNewer: { key: string; value: string }[] = [];
  const setAside = facts.setAside ?? {};
  /** Set by the person: stored, or a newer build's value this build set aside. */
  const isSet = (k: keyof UserLlmFusionConfig): boolean =>
    stored[k] !== undefined || setAside[`llm.runMode.fusion.${k}`] !== undefined;
  const fusion: Partial<UserLlmFusionConfig> = {};
  const tips: string[] = [];

  if (o.addProvider) {
    changes.push({ key: `llm.providers[+${o.addProvider.id}]`, from: undefined, to: o.addProvider });
  }
  const set = (key: string, from: unknown, to: unknown): void => {
    if (from === to) unchanged.push(key);
    else changes.push({ key, from, to });
  };
  set("llm.activeTextProvider", facts.activeTextProvider, orchestrator.providerId);
  set("llm.runMode.mode", facts.runMode?.mode, "fusion");
  /** The legs are always pinned: the point of the command. */
  const pin = <K extends keyof UserLlmFusionConfig>(k: K, to: UserLlmFusionConfig[K]): void => {
    set(`llm.runMode.fusion.${k}`, stored[k], to);
    fusion[k] = to;
  };
  /** A setting the person wrote is theirs; only an unset one gets the preset's value. */
  const fill = <K extends keyof UserLlmFusionConfig>(k: K, to: UserLlmFusionConfig[K]): void => {
    const key = `llm.runMode.fusion.${k}`;
    const newer = setAside[key];
    if (newer !== undefined) {
      // Writing over it would replace a newer build's choice with this
      // build's default; leaving it out of the write keeps it on disk.
      keptNewer.push({ key, value: newer });
    } else if (stored[k] === undefined) {
      changes.push({ key, from: undefined, to });
      fusion[k] = to;
    } else {
      unchanged.push(key);
    }
  };
  /** An opt-in left alone: listed when a newer build set it. */
  const noteNewer = (k: keyof UserLlmFusionConfig): void => {
    const key = `llm.runMode.fusion.${k}`;
    const newer = setAside[key];
    if (newer !== undefined) keptNewer.push({ key, value: newer });
  };
  pin("orchestratorProvider", orchestrator.providerId);
  pin("workerProvider", worker.providerId);
  fill("autoReplan", FUSION_SETUP_AUTO_REPLAN);
  if (orchestrator.priced) {
    fill("escalation", "advisor");
    fill("turnBudgetUsd", FUSION_SETUP_TURN_BUDGET_USD);
  } else {
    if (!isSet("escalation")) {
      tips.push(
        "escalation stays off: its per-escalation dollar cap needs a priced orchestrator, and a subscription leg has none.",
      );
    }
    tips.push(
      "no dollar cap on a subscription leg; the counted caps (maxRoundsPerTurn, maxTasksPerTurn, maxOrchestratorTasksPerTurn) hold a turn at their defaults.",
    );
  }
  if (options.judge) pin("judge", "on");
  else if (isSet("judge")) noteNewer("judge");
  else {
    tips.push(
      "judge is off: re-run with --judge to close each task only on a green acceptance checklist (more orchestrator calls).",
    );
  }
  if (options.isolation) pin("isolation", "worktree");
  else if (isSet("isolation")) noteNewer("isolation");
  else {
    tips.push(
      "isolation is off (a global setting): re-run with --isolation to give each task its own workspace, merged back after its wave; best in git repos.",
    );
  }
  return {
    ok: true,
    orchestrator,
    worker,
    changes,
    unchanged,
    keptNewer,
    write: {
      ...(o.addProvider ? { addProvider: o.addProvider } : {}),
      activeTextProvider: orchestrator.providerId,
      fusion,
    },
    tips,
  };
}
