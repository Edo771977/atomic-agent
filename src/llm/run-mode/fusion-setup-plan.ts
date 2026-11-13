import type { UserLlmProviderEntry } from "../../config/llm-config.js";
import {
  LOCAL_PROVIDER_KIND,
  type UserLlmFusionConfig,
  type UserLlmRunModeConfig,
} from "../../config/llm-run-mode-config.js";
import { SUBSCRIPTION_CLI_KIND } from "../../config/provider-auth-mode.js";
import { modelTierKey, modelTierOf, type ModelTier } from "../provider/presets/model-tiers.js";
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
  /** The entry's `defaultChatModel`: what serves its turns. */
  readonly defaultChatModel?: string | null;
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
  /** The model that serves it (`defaultChatModel`), null for the provider's own default. */
  readonly model: string | null;
  /** Its Cheap/Balanced/Best tier for this provider, when the tier table lists it. */
  readonly tier: ModelTier | null;
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
      /**
       * Every orchestrator that can answer, in the planner's order (the
       * first is its pick); more than one means the person may choose.
       */
      readonly candidates: readonly FusionSetupLeg[];
      readonly worker: FusionSetupLeg;
      /** What the write changes; empty means everything is already set. */
      readonly changes: readonly FusionSetupChange[];
      /** Keys already at the preset's value, or set by the person and kept. */
      readonly unchanged: readonly string[];
      /** Values a newer build wrote that this build cannot read; left as they are. */
      readonly keptNewer: readonly { readonly key: string; readonly value: string }[];
      readonly write: FusionSetupWrite;
      readonly tips: readonly string[];
      /** About the orchestrator pick: a stored leg kept unverified, or replaced and why. */
      readonly warnings: readonly string[];
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

function leg(
  p: { id: string; kind: string; subscriptionCli?: string | null },
  why: string,
  model: string | null = null,
): FusionSetupLeg {
  return {
    providerId: p.id,
    kind: p.kind,
    priced: p.kind !== LOCAL_PROVIDER_KIND && p.kind !== SUBSCRIPTION_CLI_KIND,
    why,
    model,
    tier: model === null ? null : modelTierOf(modelTierKey(p.kind, p.subscriptionCli ?? undefined), model),
  };
}

/** Strongest first; a model the tier table does not list sits between Balanced and Cheap. */
const TIER_RANK: Readonly<Record<ModelTier, number>> = { best: 0, balanced: 1, cheap: 3 };
const tierRank = (l: FusionSetupLeg): number => (l.tier === null ? 2 : TIER_RANK[l.tier]);

function freeId(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * How the stored orchestrator stands: `ready`, `unverified` (the check
 * was inconclusive: a CLI login that could not be read, a key that is
 * not required or not checkable), or `broken` with the reason. Only a
 * broken one is replaced: an inconclusive check (the CLI check timing
 * out) must not swap a flat-rate leg for a billed one.
 */
function storedOrchestratorState(
  facts: FusionSetupFacts,
  id: string,
): { state: "ready" } | { state: "unverified"; why: string } | { state: "broken"; why: string } {
  const p = facts.providers.find((e) => e.id === id);
  if (!p) return { state: "broken", why: `it is no longer in llm.providers` };
  if (isLocal(p)) return { state: "broken", why: "it is a local provider" };
  if (isSubscription(p)) {
    const st = facts.subscriptionClis[p.subscriptionCli ?? ""];
    if (st?.state === "ready") return { state: "ready" };
    if (st?.state === "signed_out") {
      return { state: "broken", why: `its CLI is not signed in${st.fix ? ` (run: ${st.fix})` : ""}` };
    }
    if (st?.state === "missing") {
      return { state: "broken", why: `its CLI is not installed${st.fix ? ` (${st.fix})` : ""}` };
    }
    return { state: "unverified", why: "its CLI login could not be checked" };
  }
  if (p.keyState === "present") return { state: "ready" };
  if (p.keyState === "missing") {
    return { state: "broken", why: `it has no API key${p.envVar ? ` (${p.envVar})` : ""}` };
  }
  return { state: "unverified", why: "its key could not be checked" };
}

interface OrchestratorCandidate {
  readonly leg: FusionSetupLeg;
  readonly addProvider?: UserLlmProviderEntry;
}

/**
 * Every orchestrator that can answer now, best first:
 *  1. the stored fusion orchestrator, unless it is definitely not ready;
 *  2. the active text provider, when it is a cloud provider;
 *  3. a signed-in subscription CLI (an entry, else a new Claude Code one);
 *  4. other keyed cloud providers, Best/Balanced tier models first.
 * A key alone says nothing about strength (it may be there for a cheap or
 * embedding model), so a configured, signed-in subscription comes before
 * a keyed provider the person did not make active.
 */
function orchestratorCandidates(facts: FusionSetupFacts): {
  candidates: OrchestratorCandidate[];
  warnings: string[];
} {
  const fusion = facts.runMode?.fusion;
  const stored = fusion?.orchestratorProvider;
  const warnings: string[] = [];
  const out: OrchestratorCandidate[] = [];
  const push = (c: OrchestratorCandidate): void => {
    if (!out.some((o) => o.leg.providerId === c.leg.providerId)) out.push(c);
  };
  const entryLeg = (p: FusionSetupProviderFact, why: string): FusionSetupLeg =>
    leg(p, why, (p.id === stored ? fusion?.orchestratorModel : undefined) ?? p.defaultChatModel ?? null);

  if (stored !== undefined) {
    const st = storedOrchestratorState(facts, stored);
    const entry = facts.providers.find((p) => p.id === stored);
    if (st.state === "broken") {
      warnings.push(`${stored} (the orchestrator already set) is replaced: ${st.why}.`);
    } else if (entry) {
      if (st.state === "unverified") {
        warnings.push(
          `${stored} (the orchestrator already set) could not be verified: ${st.why}; kept. Check it with: atomic-agent providers status`,
        );
      }
      push({ leg: entryLeg(entry, "the orchestrator already set for fusion") });
    }
  }
  const active = facts.providers.find((p) => p.id === facts.activeTextProvider);
  if (active && orchestratorReady(facts, active)) {
    push({ leg: entryLeg(active, "your active cloud provider") });
  }
  for (const p of facts.providers) {
    if (isSubscription(p) && orchestratorReady(facts, p)) {
      push({ leg: entryLeg(p, "a configured subscription CLI that is signed in") });
    }
  }
  const claudeEntry = facts.providers.some((p) => isSubscription(p) && p.subscriptionCli === "claude");
  if (cliReady(facts, "claude") && !claudeEntry) {
    const id = freeId("claude-cli", facts.providers.map((p) => p.id));
    const addProvider: UserLlmProviderEntry = {
      id,
      kind: SUBSCRIPTION_CLI_KIND,
      ...(facts.claudeCliDefaultModel ? { defaultChatModel: facts.claudeCliDefaultModel } : {}),
      subscriptionCli: { cli: "claude" },
    };
    push({
      leg: leg(
        { id, kind: SUBSCRIPTION_CLI_KIND, subscriptionCli: "claude" },
        "your signed-in Claude Code subscription (new provider entry)",
        facts.claudeCliDefaultModel,
      ),
      addProvider,
    });
  }
  const keyed = facts.providers
    .filter((p) => !isSubscription(p) && orchestratorReady(facts, p))
    .map((p, i) => ({ l: entryLeg(p, "a configured cloud provider with a key"), i }))
    .sort((a, b) => tierRank(a.l) - tierRank(b.l) || a.i - b.i);
  for (const { l } of keyed) push({ leg: l });
  return { candidates: out, warnings };
}

function pickOrchestrator(
  facts: FusionSetupFacts,
  pick: string | undefined,
):
  | {
      leg: FusionSetupLeg;
      addProvider?: UserLlmProviderEntry;
      candidates: FusionSetupLeg[];
      warnings: string[];
    }
  | { problems: string[] } {
  const { candidates, warnings } = orchestratorCandidates(facts);
  if (candidates.length === 0) {
    return { problems: [...warnings, ...noOrchestratorProblems(facts)] };
  }
  const chosen =
    pick === undefined ? candidates[0] : candidates.find((c) => c.leg.providerId === pick);
  if (!chosen) {
    return {
      problems: [
        `${pick} cannot orchestrate now; ready: ${candidates.map((c) => c.leg.providerId).join(", ")}.`,
      ],
    };
  }
  if (chosen.leg.tier === "cheap") {
    warnings.push(
      `${chosen.leg.model} is the Cheap tier for ${chosen.leg.providerId}. The orchestrator plans and reviews every task, so a Balanced or Best model does better; change its model in the TUI: Manage › LLM.`,
    );
  }
  return {
    leg: chosen.leg,
    ...(chosen.addProvider ? { addProvider: chosen.addProvider } : {}),
    candidates: candidates.map((c) => c.leg),
    warnings,
  };
}

function noOrchestratorProblems(facts: FusionSetupFacts): string[] {
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
  return problems;
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
  /** The orchestrator the person picked (a candidate's provider id); default: the planner's first. */
  readonly orchestrator?: string;
}

/** Propose the two legs and the preset's settings, or say what is missing. */
export function planFusionSetup(
  facts: FusionSetupFacts,
  options: FusionSetupOptions = {},
): FusionSetupPlan {
  const o = pickOrchestrator(facts, options.orchestrator);
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
    candidates: o.candidates,
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
    warnings: o.warnings,
  };
}
