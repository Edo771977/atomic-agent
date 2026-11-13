import { ConfigValidationError, getUserConfigPath, resolveStateDir } from "../config/index.js";
import { applyFusionSetupInConfig } from "../config/fusion-setup-commands.js";
import { FUSION_TURN_BUDGET_USD_MAX } from "../config/llm-run-mode-config.js";
import {
  planFusionSetup,
  type FusionSetupChange,
  type FusionSetupFacts,
  type FusionSetupLeg,
  type FusionSetupPlan,
} from "../llm/run-mode/fusion-setup-plan.js";
import { MODEL_TIER_LABELS } from "../llm/provider/presets/model-tiers.js";
import { detectFusionSetup, type FusionDetectDeps } from "./setup-fusion-detect.js";
import { createSetupPrompter, type SetupPrompter, type SetupTerminal } from "./setup-terminal-prompt.js";

/**
 * `atomic-agent setup fusion [--yes] [--dry-run]`: one command from a
 * fresh install to "a strong model plans, the local model executes".
 * Detects the legs, shows what will change, asks, and writes the config
 * in one validated write. Exit 0 when set (or already set, or a dry
 * run), 1 when a leg is missing or the change was declined, 2 on a
 * usage error.
 */
const HELP = [
  "Usage: atomic-agent setup fusion [--yes] [--dry-run] [--judge] [--isolation]",
  "                                 [--orchestrator <provider-id>] [--budget <usd>]",
  "",
  "Sets up Fusion: a strong model orchestrates (a cloud provider with a key, or",
  "your signed-in Claude Code subscription) and the local model runs the workers.",
  "Shows what it will change and asks first. When more than one strong model is",
  "ready it lists them and asks which one orchestrates.",
  "",
  "  --yes        Apply without asking",
  "  --dry-run    Print the plan; write nothing",
  "  --judge      Also turn on the judge (a task closes only on a green checklist)",
  "  --isolation  Also give each worker task its own workspace (worktree)",
  "  --orchestrator <provider-id>",
  "               Orchestrate with this ready provider instead of the suggested one",
  "  --budget <usd>",
  "               Spend cap per fusion turn (default 1 on a per-token orchestrator):",
  "               once reached, no new delegation or worker starts and the",
  "               orchestrator reports what is done. 0 means no cap",
].join("\n");

export interface SetupCommandDeps {
  readonly write?: (text: string) => void;
  readonly stateDir?: string;
  readonly detect?: FusionDetectDeps;
  /** Ask the person; default reads a line from the terminal, refuses otherwise. */
  readonly confirm?: (question: string) => Promise<boolean | "no-tty">;
  /** Where the default questions are read and asked (default: stdin/stdout). */
  readonly terminal?: SetupTerminal;
  readonly apply?: typeof applyFusionSetupInConfig;
}

function price(l: FusionSetupLeg): string {
  return l.kind === "llama-server" ? "local" : l.priced ? "billed per token" : "subscription, flat rate";
}

/** `openrouter · some/model (Best tier)`: the provider AND the model that serves it. */
function legName(l: FusionSetupLeg): string {
  if (l.kind === "llama-server") return l.providerId;
  const tier = l.tier ? ` (${MODEL_TIER_LABELS[l.tier]} tier)` : "";
  return `${l.providerId} · ${l.model ?? "its default model"}${tier}`;
}

function show(value: unknown): string {
  return value === undefined ? "(unset)" : JSON.stringify(value);
}

function legLine(label: string, l: FusionSetupLeg | null): string {
  if (!l) return `  ${label.padEnd(13)} (none available)`;
  return `  ${label.padEnd(13)} ${legName(l)}  — ${l.why}; ${price(l)}`;
}

function changeLine(c: FusionSetupChange): string {
  if (c.key.startsWith("llm.providers[+")) {
    const entry = c.to as { id: string };
    return `  add provider ${entry.id} (Claude Code subscription; signs in through the CLI, no key stored)`;
  }
  return `  ${c.key.padEnd(36)} ${show(c.from)} → ${show(c.to)}`;
}

export function renderFusionPlan(plan: FusionSetupPlan): string {
  const lines = [
    "Fusion: a strong model plans, the local model executes.",
    "",
    legLine("orchestrator", plan.orchestrator),
    legLine("workers", plan.worker),
    "",
  ];
  if (!plan.ok) {
    lines.push("Can't set it up yet:", ...plan.problems.map((p) => `  - ${p}`), "");
    return `${lines.join("\n")}\n`;
  }
  if (plan.candidates.length > 1) {
    const others = plan.candidates.filter((c) => c.providerId !== plan.orchestrator.providerId);
    lines.push(
      "Also ready to orchestrate:",
      ...others.map((c) => `  ${legName(c)}  — ${price(c)}`),
      "  pick one with: atomic-agent setup fusion --orchestrator <provider-id>",
      "",
    );
  }
  if (plan.warnings.length > 0) {
    lines.push(...plan.warnings.map((w) => `  ! ${w}`), "");
  }
  if (plan.changes.length > 0) {
    lines.push("Will change:", ...plan.changes.map(changeLine), "");
  }
  if (plan.keptNewer.length > 0) {
    lines.push(
      "Will keep:",
      ...plan.keptNewer.map((k) => `  ${k.key.padEnd(36)} ${JSON.stringify(k.value)} kept (set by a newer version)`),
      "",
    );
  }
  if (plan.unchanged.length > 0) {
    lines.push(`Already set: ${plan.unchanged.join(", ")}`, "");
  }
  if (plan.tips.length > 0) {
    lines.push("Notes:", ...plan.tips.map((t) => `  - ${t}`), "");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * More than one orchestrator is ready and a person is at the terminal:
 * list them and ask, Enter keeping the planner's pick. Null when nothing
 * was asked (not a terminal) or the input ended.
 */
async function pickOrchestrator(
  candidates: readonly FusionSetupLeg[],
  prompter: SetupPrompter,
  write: (t: string) => void,
): Promise<string | null> {
  write(
    [
      "More than one strong model can orchestrate:",
      ...candidates.map(
        (c, i) => `  ${i + 1}) ${legName(c)}  — ${price(c)}${i === 0 ? "  (suggested)" : ""}`,
      ),
      "",
    ].join("\n"),
  );
  let question = `Which one? [1-${candidates.length}, Enter = 1] `;
  for (;;) {
    const answer = await prompter.ask(question);
    if (answer === "no-tty" || answer === null) return null;
    const t = answer.trim();
    if (t === "") return candidates[0]!.providerId;
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1 && n <= candidates.length) return candidates[n - 1]!.providerId;
    const byId = candidates.find((c) => c.providerId === t);
    if (byId) return byId.providerId;
    question = `Type a number from 1 to ${candidates.length} (Enter = 1): `;
  }
}

async function setupFusion(args: readonly string[], deps: SetupCommandDeps): Promise<number> {
  const prompter = createSetupPrompter(deps.terminal);
  try {
    return await runSetupFusion(args, deps, prompter);
  } finally {
    prompter.close();
  }
}

async function runSetupFusion(
  args: readonly string[],
  deps: SetupCommandDeps,
  prompter: SetupPrompter,
): Promise<number> {
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  let yes = false;
  let dryRun = false;
  let judge = false;
  let isolation = false;
  let orchestrator: string | undefined;
  let budgetUsd: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--judge") judge = true;
    else if (a === "--isolation") isolation = true;
    else if (a === "--orchestrator") {
      const v = args[++i];
      if (!v || v.startsWith("-")) { write(`--orchestrator needs a provider id\n\n${HELP}\n`); return 2; }
      orchestrator = v;
    }
    else if (a === "--budget") {
      const v = args[++i];
      const n = v === undefined || v.trim() === "" ? Number.NaN : Number(v);
      if (!Number.isFinite(n) || n < 0 || n > FUSION_TURN_BUDGET_USD_MAX) {
        write(`--budget needs a dollar amount from 0 to ${FUSION_TURN_BUDGET_USD_MAX} (0 = no cap)\n\n${HELP}\n`);
        return 2;
      }
      budgetUsd = n;
    }
    else if (a === "-h" || a === "--help") { write(`${HELP}\n`); return 0; }
    else { write(`unknown option "${a}"\n\n${HELP}\n`); return 2; }
  }
  const stateDir = deps.stateDir ?? resolveStateDir();
  const configPath = getUserConfigPath(stateDir);
  let facts: FusionSetupFacts;
  try {
    facts = await detectFusionSetup(stateDir, deps.detect);
  } catch (err) {
    if (!(err instanceof ConfigValidationError)) throw err;
    write(`${err.message}\n\nFix or move ${configPath}, then run this again. Nothing was written.\n`);
    return 1;
  }
  const opts = { judge, isolation, ...(budgetUsd === undefined ? {} : { budgetUsd }) };
  let plan = planFusionSetup(facts, { ...opts, ...(orchestrator ? { orchestrator } : {}) });
  if (plan.ok && plan.candidates.length > 1 && !yes && !dryRun && orchestrator === undefined && prompter.isTerminal) {
    const picked = await pickOrchestrator(plan.candidates, prompter, write);
    if (picked !== null && picked !== plan.orchestrator.providerId) {
      plan = planFusionSetup(facts, { ...opts, orchestrator: picked });
    }
    write("\n");
  }
  write(renderFusionPlan(plan));
  if (!plan.ok) return 1;
  if (plan.changes.length === 0) {
    write("Fusion is already set up. Start it with: atomic-agent tui\n");
    return 0;
  }
  if (dryRun) {
    write("Dry run: nothing written.\n");
    return 0;
  }
  if (!yes) {
    const confirm =
      deps.confirm ??
      (async (q: string) => {
        const a = await prompter.ask(q);
        return a === "no-tty" ? a : a !== null && /^(y|yes)$/i.test(a.trim());
      });
    const answer = await confirm("Apply these changes? [y/N] ");
    if (answer === "no-tty") {
      write("Not a terminal, so nothing was asked or written; re-run with --yes to apply.\n");
      return 1;
    }
    if (!answer) {
      write("Nothing written.\n");
      return 1;
    }
  }
  (deps.apply ?? applyFusionSetupInConfig)(plan.write);
  write(`Fusion is on, in ${configPath}. Start it with: atomic-agent tui\n`);
  return 0;
}

export async function setupCommand(args: string[], deps: SetupCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  const [sub, ...rest] = args;
  if (!sub || sub === "-h" || sub === "--help") {
    write(`${HELP}\n`);
    return sub ? 0 : 2;
  }
  if (sub !== "fusion") {
    write(`unknown setup target "${sub}"\n\n${HELP}\n`);
    return 2;
  }
  return setupFusion(rest, deps);
}
