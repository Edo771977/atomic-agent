import { DailySpendLimitError, type DailySpendLimitAction } from "../llm/reliability/spend-limit-error.js";
import { effectiveDailyLimitUsd, type DailySpendStore } from "../session/daily-spend.js";

/** One send's share of today's allowance, held until the reply settles it. */
export interface DailySpendHold {
  /**
   * Close the hold and add the call to today's total: `actualUsd` when it
   * is known, otherwise the whole hold; a zero hold with nothing known is
   * one unpriced call.
   */
  settle(actualUsd?: number): void;
  /** Close the hold without counting anything: the send never left. */
  release(): void;
}

/**
 * The daily spend ceiling (`llm.costTracking.dailyLimitUsd`, ATO-649) as
 * the request budget's second ledger, next to the turn budget. Holds live
 * in this process on top of the persisted total, so parallel sends of
 * this process cannot all pass on an allowance that covers one. Another
 * process (the terminal next to the desktop app) sees only what was
 * settled: there is no cross-process lock, so two processes can together
 * overshoot by their in-flight holds.
 */
export interface DailySpendBudget {
  /** Today's ceiling, read live; `null` when none is set. */
  limitUsd(): number | null;
  /**
   * Hold `upperUsd` of today's allowance for a send to `providerId`.
   * Throws `DailySpendLimitError` when the persisted total plus this
   * process's open holds leaves no room for it; a zero hold is refused
   * only once the total is at or over the ceiling.
   */
  reserve(providerId: string, upperUsd: number): DailySpendHold;
  /** Count a completion seen without a hold: `usd` when known, else unpriced. */
  charge(usd: number | undefined): void;
}

export function createDailySpendBudget(
  store: DailySpendStore,
  costTracking: () => { dailyLimitUsd?: number; onDailyLimit?: DailySpendLimitAction } | undefined,
): DailySpendBudget {
  let heldUsd = 0;
  const known = (usd: number | undefined): usd is number =>
    usd !== undefined && Number.isFinite(usd) && usd >= 0;
  const charge = (usd: number | undefined): void => {
    store.add(known(usd) ? usd : undefined);
  };
  return {
    limitUsd: () => effectiveDailyLimitUsd(costTracking()?.dailyLimitUsd),
    reserve(providerId, upperUsd) {
      if (!Number.isFinite(upperUsd) || upperUsd < 0) throw new Error("daily spend estimate is not finite");
      const settings = costTracking();
      const limitUsd = effectiveDailyLimitUsd(settings?.dailyLimitUsd);
      if (limitUsd !== null) {
        const committed = store.today().usd + heldUsd;
        const over = upperUsd > 0 ? committed + upperUsd > limitUsd + 1e-10 : committed >= limitUsd;
        if (over) {
          throw new DailySpendLimitError({
            spentUsd: committed,
            limitUsd,
            providerId,
            onLimit: settings?.onDailyLimit === "local" ? "local" : "stop",
          });
        }
      }
      heldUsd += upperUsd;
      let open = true;
      const close = (): boolean => {
        if (!open) return false;
        open = false;
        heldUsd = Math.max(0, heldUsd - upperUsd);
        return true;
      };
      return {
        release: () => { close(); },
        settle: (actualUsd) => {
          if (!close()) return;
          charge(known(actualUsd) ? actualUsd : upperUsd > 0 ? upperUsd : undefined);
        },
      };
    },
    charge,
  };
}
