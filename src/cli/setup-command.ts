import { createInterface } from "node:readline/promises";

import { resolveStateDir } from "../config/index.js";
import { applyFusionSetupInConfig } from "../config/fusion-setup-commands.js";
import {
  planFusionSetup,
  type FusionSetupChange,
  type FusionSetupFacts,
  type FusionSetupLeg,
  type FusionSetupPlan,
} from "../llm/run-mode/fusion-setup-plan.js";
import { detectFusionSetup, type FusionDetectDeps } from "./setup-fusion-detect.js";

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
  "",
  "Sets up Fusion: a strong model orchestrates (a cloud provider with a key, or",
  "your signed-in Claude Code subscription) and the local model runs the workers.",
  "Shows what it will change and asks first.",
  "",
  "  --yes        Apply without asking",
  "  --dry-run    Print the plan; write nothing",
  "  --judge      Also turn on the judge (a task closes only on a green checklist)",
  "  --isolation  Also give each worker task its own workspace (worktree)",
].join("\n");

export interface SetupCommandDeps {
  readonly write?: (text: string) => void;
  readonly stateDir?: string;
  readonly detect?: FusionDetectDeps;
  /** Ask the person; default reads a line from a terminal, refuses otherwise. */
  readonly confirm?: (question: string) => Promise<boolean | "no-tty">;
  readonly apply?: typeof applyFusionSetupInConfig;
}

async function terminalConfirm(question: string): Promise<boolean | "no-tty"> {
  if (!process.stdin.isTTY) return "no-tty";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function show(value: unknown): string {
  return value === undefined ? "(unset)" : JSON.stringify(value);
}

function legLine(label: string, l: FusionSetupLeg | null): string {
  if (!l) return `  ${label.padEnd(13)} (none available)`;
  const price = l.kind === "llama-server" ? "local" : l.priced ? "billed per token" : "subscription, flat rate";
  return `  ${label.padEnd(13)} ${l.providerId}  — ${l.why}; ${price}`;
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
  if (plan.changes.length > 0) {
    lines.push("Will change:", ...plan.changes.map(changeLine), "");
  }
  if (plan.unchanged.length > 0) {
    lines.push(`Already set: ${plan.unchanged.join(", ")}`, "");
  }
  if (plan.tips.length > 0) {
    lines.push("Notes:", ...plan.tips.map((t) => `  - ${t}`), "");
  }
  return `${lines.join("\n")}\n`;
}

async function setupFusion(args: readonly string[], deps: SetupCommandDeps): Promise<number> {
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  let yes = false;
  let dryRun = false;
  let judge = false;
  let isolation = false;
  for (const a of args) {
    if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--judge") judge = true;
    else if (a === "--isolation") isolation = true;
    else if (a === "-h" || a === "--help") { write(`${HELP}\n`); return 0; }
    else { write(`unknown option "${a}"\n\n${HELP}\n`); return 2; }
  }
  const stateDir = deps.stateDir ?? resolveStateDir();
  const facts: FusionSetupFacts = await detectFusionSetup(stateDir, deps.detect);
  const plan = planFusionSetup(facts, { judge, isolation });
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
    const answer = await (deps.confirm ?? terminalConfirm)("Apply these changes? [y/N] ");
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
  write(`Fusion is on, in ${stateDir}/config.json. Start it with: atomic-agent tui\n`);
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
