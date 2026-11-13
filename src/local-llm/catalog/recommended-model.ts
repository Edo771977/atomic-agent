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
import { DEFAULT_SLOTS, workerSlotFootprint } from "../server/worker-slots.js";
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
   * (`localModels.managed.parallel`; `auto` reads as
   * {@link DEFAULT_SLOTS}). Each slot past the first needs room for one
   * more worker's KV cache.
   */
  parallel?: number;
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
  /** The slots asked for. */
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
 * The model for fusion's workers on this memory, and why. Eligible
 * entries are the default role's (ranked, not reduced-refusal, within
 * `recommendedRamGb` and the download limit). They are ordered by
 * rating (`good` > `ok` > unrated > `poor`), then by whether the memory
 * also holds every requested worker slot (a model that only fits with
 * one slot comes after those that fit them all), then by
 * `recommendRank`. Null when nothing fits.
 */
export function recommendWorkerModel(
  memoryGb: number,
  options: Omit<RecommendedModelOptions, "role"> = {},
): WorkerModelPick | null {
  const slotsWanted = Math.max(1, Math.floor(options.parallel ?? DEFAULT_SLOTS));
  const rows = eligible(memoryGb, options).map((def) => {
    const fit = fitOf(def);
    const perSlotGb = workerSlotKvGb(def);
    const spare = memoryGb - def.recommendedRamGb;
    const slots = Math.min(slotsWanted, 1 + Math.max(0, Math.floor(spare / perSlotGb)));
    return {
      def,
      fit,
      slots,
      perSlotGb,
      order: RATING_ORDER[fit?.rating ?? "unrated"],
      allSlots: slots >= slotsWanted ? 0 : 1,
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
  const why: string[] = [
    best.fit === null
      ? "no fusion-worker rating recorded for it; nothing rated better fits"
      : `rated ${best.fit.rating} as a fusion worker: ${best.fit.note}`,
    best.slots >= slotsWanted
      ? `fits ${slotsWanted} worker slot${slotsWanted === 1 ? "" : "s"}: needs about ${round1(needGb)} GB of ${memoryGb} GB`
      : `fits ${best.slots} of ${slotsWanted} worker slots in ${memoryGb} GB (each extra slot needs about ${round1(best.perSlotGb)} GB); run fewer workers at once`,
    `catalog rank ${best.def.recommendRank}`,
  ];
  return {
    model: best.def,
    fit: best.fit,
    slots: best.slots,
    slotsWanted,
    needGb,
    why,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
