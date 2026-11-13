/**
 * The one rule for "which local model should this machine get": the
 * best-ranked well-known model (`LocalModelDef.recommendRank`) that runs
 * comfortably in the given memory. It replaces "the biggest model that
 * fits", which ranked by size alone and so put a less common 30B ahead
 * of the popular families. The first-run picker and the desktop both
 * follow this order.
 *
 * `role: "worker"` asks a different question: which model should run
 * fusion's workers (a strong model directs, this one executes). Then a
 * model's recorded fusion-worker rating (`LocalModelDef.fusionWorker`)
 * comes first, the memory left for the server's parallel worker slots
 * second, and `recommendRank` last.
 */

import { estimateLaunchKvBytes } from "../server/context-size.js";
import { GPU_AUTO_MAX_SLOTS } from "../server/context-growth.js";
import {
  MAX_AUTO_SLOTS,
  resolveWorkerSlots,
  workerSlotFootprint,
} from "../server/worker-slots.js";
import {
  LOCAL_MODELS_CATALOG,
  parseFusionWorkerFit,
  type FusionWorkerFit,
  type LocalModelDef,
} from "./models-catalog.js";

/** `default`: the chat model for the machine. `worker`: fusion's workers. */
export type RecommendRole = "default" | "worker";

export interface RecommendedModelOptions {
  /** Defaults to the curated catalog. */
  catalog?: readonly LocalModelDef[];
  /**
   * Skip entries whose weights download is larger than this, in GB. The
   * first-run picker sets it so a fresh install reaches a working agent
   * quickly; omitted, size does not matter.
   */
  maxDownloadGb?: number;
  /** Omitted: `default`, the order every existing caller relies on. */
  role?: RecommendRole;
  /**
   * `role: "worker"` only: the server's request slots, one worker each
   * (`localModels.managed.parallel`). A number is the slots asked for;
   * `auto` (and omitted) is what the managed daemon's own auto sizing
   * gives (`resolveWorkerSlots`): as many as the memory holds, up to
   * {@link MAX_AUTO_SLOTS} — {@link GPU_AUTO_MAX_SLOTS} on a GPU with
   * memory of its own — and one on the CPU. Each slot past the first
   * needs room for one more worker's KV cache.
   */
  parallel?: number | "auto";
  /**
   * `role: "worker"` only: GPU memory the weights load into, decimal GB
   * (`MachineForModels.gpuBudgetGb`); `null` / omitted when not known.
   * Known, the slots must also fit beside the weights there.
   */
  gpuBudgetGb?: number | null;
  /** `role: "worker"` only: the model runs on the CPU (one auto slot). */
  cpuOnly?: boolean;
  /**
   * `role: "worker"` only: the GPU has memory of its own (not unified
   * with RAM), where the daemon caps auto slots at
   * {@link GPU_AUTO_MAX_SLOTS}.
   */
  dedicatedGpu?: boolean;
}

/**
 * The best-ranked model whose `recommendedRamGb` is at most `memoryGb`,
 * or null when none is. Reduced-refusal (`uncensored`) and unranked
 * entries are never returned: choosing one has to be the operator's own
 * act. With `role: "worker"`, {@link recommendWorkerModel}'s pick.
 */
export function recommendedModelFor(
  memoryGb: number,
  options: RecommendedModelOptions = {},
): LocalModelDef | null {
  if (options.role === "worker") {
    return recommendWorkerModel(memoryGb, options)?.model ?? null;
  }
  let best: LocalModelDef | null = null;
  for (const def of eligible(memoryGb, options)) {
    if (best === null || def.recommendRank! < (best.recommendRank ?? Infinity)) best = def;
  }
  return best;
}

/** Ranked, safe-by-default, fits the memory and the download limit. */
function eligible(memoryGb: number, options: RecommendedModelOptions): LocalModelDef[] {
  const catalog = options.catalog ?? LOCAL_MODELS_CATALOG;
  const maxDownloadGb = options.maxDownloadGb ?? Number.POSITIVE_INFINITY;
  return catalog.filter(
    (def) =>
      def.recommendRank !== undefined &&
      def.uncensored !== true &&
      def.recommendedRamGb <= memoryGb &&
      def.fileSizeGb <= maxDownloadGb,
  );
}

export interface WorkerModelPick {
  model: LocalModelDef;
  /** The rating it was ranked by; `null` for an unrated model. */
  fit: FusionWorkerFit | null;
  /** Slots the pick leaves room for (at least one). */
  slots: number;
  /** The slots asked for (a pinned `parallel`), or what `auto` sizes to (= `slots`). */
  slotsWanted: number;
  /** Memory the pick needs with those slots, in GB. */
  needGb: number;
  /** Plain reasons, in ranking order: rating, memory, rank. */
  why: string[];
}

/** Lower sorts first. Unrated sits between `ok` and `poor`. */
const RATING_ORDER: Record<FusionWorkerFit["rating"] | "unrated", number> = {
  good: 0,
  ok: 1,
  unrated: 2,
  poor: 3,
};

/**
 * KV cache one more worker slot needs, in GB: a worker's peak footprint
 * (`workerSlotFootprint`) at the launch's file-size estimate, the same
 * deliberately generous scale the auto-sized context uses when no GGUF
 * header was read.
 */
export function workerSlotKvGb(def: Pick<LocalModelDef, "fileSizeGb">): number {
  return (
    estimateLaunchKvBytes({
      kvLayout: null,
      modelSizeGb: def.fileSizeGb,
      contextSize: workerSlotFootprint(),
    }) / 1e9
  );
}

/** The model's rating when it is well formed, else unrated. */
function fitOf(def: LocalModelDef): FusionWorkerFit | null {
  try {
    return parseFusionWorkerFit(def.fusionWorker) ?? null;
  } catch {
    return null;
  }
}

/**
 * Worker slots the memory holds for `def`, at least one: RAM past the
 * model's `recommendedRamGb` (which covers the first slot), and, when
 * the GPU budget is known, what fits beside the weights there — the KV
 * cache lives on the GPU, so a big RAM does not hold slots a small card
 * cannot.
 */
export function workerSlotsByMemory(
  def: Pick<LocalModelDef, "fileSizeGb" | "recommendedRamGb">,
  memoryGb: number,
  gpuBudgetGb: number | null | undefined,
): number {
  const perSlotGb = workerSlotKvGb(def);
  const byRam = 1 + Math.max(0, Math.floor((memoryGb - def.recommendedRamGb) / perSlotGb));
  const byGpu =
    typeof gpuBudgetGb === "number" && gpuBudgetGb > 0
      ? Math.floor(Math.max(0, gpuBudgetGb - def.fileSizeGb) / perSlotGb)
      : Number.POSITIVE_INFINITY;
  return Math.max(1, Math.min(byRam, byGpu));
}

/**
 * The model for fusion's workers on this memory, and why. Eligible
 * entries are the default role's (ranked, not reduced-refusal, within
 * `recommendedRamGb` and the download limit). They are ordered by
 * rating (`good` > `ok` > unrated > `poor`), then, for a pinned
 * `parallel`, by whether the memory also holds every requested worker
 * slot (a model that only fits with one slot comes after those that fit
 * them all), then by `recommendRank`. Under `auto` the slots are the
 * daemon's own sizing for that memory (`resolveWorkerSlots`), which by
 * definition is all there is room for, so they only inform. Null when
 * nothing fits.
 */
export function recommendWorkerModel(
  memoryGb: number,
  options: Omit<RecommendedModelOptions, "role"> = {},
): WorkerModelPick | null {
  const pinned = typeof options.parallel === "number";
  const cpuOnly = options.cpuOnly === true;
  // The daemon's ceiling for an auto launch (`resolveWorkerSlots`).
  const autoCeiling = cpuOnly ? 1 : options.dedicatedGpu === true ? GPU_AUTO_MAX_SLOTS : MAX_AUTO_SLOTS;
  const slotsWanted = pinned ? Math.max(1, Math.floor(options.parallel as number)) : autoCeiling;
  const rows = eligible(memoryGb, options).map((def) => {
    const fit = fitOf(def);
    const perSlotGb = workerSlotKvGb(def);
    const held = workerSlotsByMemory(def, memoryGb, cpuOnly ? null : options.gpuBudgetGb);
    const slots = pinned
      ? Math.min(slotsWanted, held)
      : resolveWorkerSlots({
          contextSize: held * workerSlotFootprint(),
          cpuOnly,
          ...(options.dedicatedGpu === true ? { maxSlots: GPU_AUTO_MAX_SLOTS } : {}),
        });
    return {
      def,
      fit,
      slots,
      perSlotGb,
      order: RATING_ORDER[fit?.rating ?? "unrated"],
      allSlots: !pinned || slots >= slotsWanted ? 0 : 1,
    };
  });
  rows.sort(
    (a, b) =>
      a.order - b.order ||
      a.allSlots - b.allSlots ||
      (a.def.recommendRank ?? Infinity) - (b.def.recommendRank ?? Infinity),
  );
  const best = rows[0];
  if (best === undefined) return null;
  const needGb = best.def.recommendedRamGb + (best.slots - 1) * best.perSlotGb;
  const gpu = cpuOnly ? null : (options.gpuBudgetGb ?? null);
  const gpuNote =
    gpu === null
      ? ""
      : ` and ${round1(best.def.fileSizeGb + best.slots * best.perSlotGb)} GB of the ${round1(gpu)} GB GPU budget`;
  const s = (n: number): string => `${n} worker slot${n === 1 ? "" : "s"}`;
  const why: string[] = [
    best.fit === null
      ? "no fusion-worker rating recorded for it; nothing rated better fits"
      : `rated ${best.fit.rating} as a fusion worker: ${best.fit.note}`,
    !pinned
      ? `auto sizing gives ${s(best.slots)} here: needs about ${round1(needGb)} GB of ${memoryGb} GB RAM${gpuNote}`
      : best.slots >= slotsWanted
        ? `fits ${s(slotsWanted)}: needs about ${round1(needGb)} GB of ${memoryGb} GB RAM${gpuNote}`
        : `fits ${best.slots} of ${slotsWanted} worker slots in ${memoryGb} GB RAM${gpu === null ? "" : ` / ${round1(gpu)} GB GPU`} (each extra slot needs about ${round1(best.perSlotGb)} GB); run fewer workers at once`,
    `catalog rank ${best.def.recommendRank}`,
  ];
  return {
    model: best.def,
    fit: best.fit,
    slots: best.slots,
    slotsWanted: pinned ? slotsWanted : best.slots,
    needGb,
    why,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
