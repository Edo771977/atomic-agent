/**
 * `models recommend [--json] [--role worker]` and
 * `models upgrade [--json] [--dry-run]` (ATO-1043, ATO-15).
 *
 * `recommend` says what this machine has and names three models for it:
 * fast, balanced, quality. `upgrade` decides whether the quality one is
 * worth fetching over the active model and, if so, starts it as a
 * background download (the detached worker `models pull --background`
 * uses), so it keeps going after the terminal or the TUI closes. It
 * never switches the model: the switch is offered by whoever shows the
 * progress (the desktop bar, the TUI), once the weights are on disk.
 *
 * `recommend --role worker` also names the model for fusion's workers
 * (a strong model directs, a local one executes): ranked by its recorded
 * fusion-worker rating, then by room for the server's parallel worker
 * slots, then by catalog rank, with the reasons (`recommendWorkerModel`).
 *
 * The desktop reads `--json` of both. Their shape is a contract: fields
 * are only ever added.
 */

import { getConfig } from "../config/index.js";
import {
  modelDownloadGb,
  modelsThisMachineCarries,
  type MachineForModels,
  type ModelUpgradeDecision,
} from "../local-llm/catalog/model-upgrade.js";
import {
  recommendWorkerModel,
  type RecommendRole,
  type WorkerModelPick,
} from "../local-llm/catalog/recommended-model.js";
import type { LocalModelDef } from "../local-llm/index.js";
import {
  readRecommendSnapshot,
  startModelUpgrade,
  type RecommendSnapshot,
} from "../local-llm/model-upgrade-runner.js";

export { readRecommendSnapshot, startModelUpgrade, type RecommendSnapshot };

/** Bumped only on a breaking change; additions keep it. */
export const RECOMMEND_JSON_VERSION = 1;

interface ModelJson {
  id: string;
  name: string;
  sizeLabel: string;
  downloadGb: number;
  description: string;
  supportsVision: boolean;
}

function modelJson(def: LocalModelDef | null): ModelJson | null {
  if (!def) return null;
  return {
    id: def.id,
    name: def.name,
    sizeLabel: def.sizeLabel,
    downloadGb: Math.round(modelDownloadGb(def) * 100) / 100,
    description: def.description,
    supportsVision: def.supportsVision === true,
  };
}

export function recommendJson(snap: RecommendSnapshot): Record<string, unknown> {
  const d = snap.decision;
  return {
    version: RECOMMEND_JSON_VERSION,
    machine: {
      ramGb: snap.machine.ramGb,
      gpuBudgetGb: round1(snap.machine.gpuBudgetGb),
      freeDiskGb: round1(snap.machine.freeDiskGb),
      cpuOnly: snap.machine.cpuOnly,
    },
    tiers: {
      fast: modelJson(snap.tiers.fast),
      balanced: modelJson(snap.tiers.balanced),
      quality: modelJson(snap.tiers.quality),
    },
    activeModelId: snap.activeModelId,
    upgrade:
      d.action === "none"
        ? { action: "none", why: d.why, model: null }
        : { action: d.action, why: null, model: modelJson(d.model) },
  };
}

function round1(n: number | null): number | null {
  return n === null ? null : Math.round(n * 10) / 10;
}

/** `--role <default|worker>` (or `--role=<…>`); `null` when the value is not a role. */
export function readRoleFlag(args: readonly string[]): RecommendRole | null {
  let value: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--role") value = args[i + 1] ?? "";
    else if (arg.startsWith("--role=")) value = arg.slice("--role=".length);
  }
  if (value === undefined) return "default";
  return value === "default" || value === "worker" ? value : null;
}

/**
 * The worker pick for this machine: among the models it carries (RAM,
 * GPU share, disk, as for the tiers), with `parallel` worker slots
 * (`localModels.managed.parallel`; `auto` sizes them as the managed
 * daemon does). The slots must fit the GPU budget beside the weights as
 * well as RAM. A GPU off macOS is taken to have memory of its own (the
 * daemon's lower auto ceiling); this probe cannot tell an integrated
 * one, which the daemon sizes against RAM.
 */
export function workerRecommendation(
  machine: MachineForModels,
  parallel: number | "auto",
  platform: NodeJS.Platform = process.platform,
): WorkerModelPick | null {
  return recommendWorkerModel(machine.ramGb, {
    catalog: modelsThisMachineCarries(machine),
    parallel,
    gpuBudgetGb: machine.gpuBudgetGb,
    cpuOnly: machine.cpuOnly,
    dedicatedGpu: !machine.cpuOnly && machine.gpuBudgetGb !== null && platform !== "darwin",
  });
}

export function workerJson(pick: WorkerModelPick | null): Record<string, unknown> | null {
  if (pick === null) return null;
  return {
    model: modelJson(pick.model),
    rating: pick.fit?.rating ?? null,
    ratingNote: pick.fit?.note ?? null,
    slots: pick.slots,
    slotsWanted: pick.slotsWanted,
    needGb: round1(pick.needGb),
    why: pick.why,
  };
}

/** `models recommend [--json] [--role worker]`. */
export async function runModelsRecommend(args: readonly string[]): Promise<number> {
  const role = readRoleFlag(args);
  if (role === null) {
    process.stderr.write("models recommend: --role takes default or worker\n");
    return 2;
  }
  const snap = await readRecommendSnapshot();
  const worker =
    role === "worker"
      ? workerRecommendation(snap.machine, getConfig().localModels.managed.parallel)
      : undefined;
  if (args.includes("--json")) {
    const json = recommendJson(snap);
    const out = worker === undefined ? json : { ...json, role, worker: workerJson(worker) };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return 0;
  }
  process.stdout.write(
    worker === undefined ? describeRecommendation(snap) : describeWorkerRecommendation(snap, worker),
  );
  return 0;
}

/** The machine line and the worker pick with its reasons. */
export function describeWorkerRecommendation(
  snap: RecommendSnapshot,
  pick: WorkerModelPick | null,
): string {
  const lines = [machineLine(snap.machine), ""];
  if (pick === null) {
    lines.push("worker model for fusion: none fits this machine");
    return `${lines.join("\n")}\n`;
  }
  const def = pick.model;
  lines.push(
    `worker model for fusion (${pick.slotsWanted} worker slot${pick.slotsWanted === 1 ? "" : "s"}):`,
    `  ${def.id.padEnd(20)} ${def.sizeLabel.padEnd(8)} ${def.description}`,
    ...pick.why.map((reason, i) => `  ${i === 0 ? "why:" : "    "} ${reason}`),
    "",
    `fetch it: 'atomic-agent models pull ${def.id}'`,
  );
  return `${lines.join("\n")}\n`;
}

function machineLine(m: MachineForModels): string {
  const gpu = m.cpuOnly
    ? "no GPU (runs on the CPU)"
    : m.gpuBudgetGb === null
      ? "GPU memory unknown"
      : `${m.gpuBudgetGb.toFixed(1)} GB for the model on the GPU`;
  const disk = m.freeDiskGb === null ? "free disk unknown" : `${m.freeDiskGb.toFixed(0)} GB free on disk`;
  return `this machine: ${m.ramGb} GB RAM, ${gpu}, ${disk}`;
}

export function describeRecommendation(snap: RecommendSnapshot): string {
  const lines = [machineLine(snap.machine), ""];
  const row = (label: string, def: LocalModelDef | null) =>
    `  ${label.padEnd(9)} ${def ? `${def.id.padEnd(20)} ${def.sizeLabel.padEnd(8)} ${def.description}` : "none fits this machine"}`;
  lines.push(
    row("fast", snap.tiers.fast),
    row("balanced", snap.tiers.balanced),
    row("quality", snap.tiers.quality),
    "",
  );
  const d = snap.decision;
  if (d.action === "download") {
    lines.push(`upgrade: ${d.model.id} is better than what runs now — 'atomic-agent models upgrade' fetches it in the background`);
  } else if (d.action === "switch") {
    lines.push(`upgrade: ${d.model.id} is already on disk — 'atomic-agent models use ${d.model.id}' switches to it`);
  } else {
    lines.push(`upgrade: none (${NONE_WORDS[d.why]})`);
  }
  return `${lines.join("\n")}\n`;
}

const NONE_WORDS: Record<Extract<ModelUpgradeDecision, { action: "none" }>["why"], string> = {
  already_best: "the active model is already the best this machine carries",
  nothing_fits: "no catalog model runs comfortably here",
  not_managed: "local models are served by your own server, not the built-in engine",
  not_wanted: "a cloud model is active",
  own_choice: "the active model is one you added yourself",
};

/**
 * `models upgrade [--json] [--dry-run]`: start the background download
 * of the big model when the decision says so. Exit 0 whether or not
 * there was anything to do; the JSON says which.
 */
export async function runModelsUpgrade(args: readonly string[]): Promise<number> {
  const json = args.includes("--json");
  const dryRun = args.includes("--dry-run");
  const { snapshot: snap, job } = await startModelUpgrade({ dryRun });
  const out = recommendJson(snap);
  const d = snap.decision;
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...out, job })}\n`);
    return 0;
  }
  if (d.action === "download") {
    process.stdout.write(
      dryRun
        ? `would download ${d.model.id} (${d.model.sizeLabel}) in the background\n`
        : `${job?.started ? "downloading" : "already downloading"} ${d.model.id} (${d.model.sizeLabel}) in the background\n` +
            `  progress: atomic-agent models downloads\n` +
            `  when done: atomic-agent models use ${d.model.id}\n`,
    );
  } else if (d.action === "switch") {
    process.stdout.write(`${d.model.id} is already on disk — 'atomic-agent models use ${d.model.id}' switches to it\n`);
  } else {
    process.stdout.write(`nothing to upgrade: ${NONE_WORDS[d.why]}\n`);
  }
  return 0;
}
