import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import {
  renameWithRetrySync,
  syncDirectoryBestEffort,
  writeFileSyncedSync,
} from "../config/durable-write.js";

import type { CompletionPrice } from "./usage-meter.js";

/**
 * What every session together has spent today (ATO-649), for the
 * composer readout (`today $1.20 of $5.00`) and for the daily ceiling
 * (`llm.costTracking.dailyLimitUsd`) that refuses paid links once it is
 * reached.
 *
 * Kept in one small JSON file in the state directory, so the total
 * survives a restart and is shared by the terminal and the desktop app
 * (both run on `~/.atomic-agent`). Every write re-reads the file first,
 * so two processes add to one total rather than overwrite each other.
 * There is no cross-process lock: two writes racing between the read and
 * the rename can still lose one call, and another process's in-flight
 * request-budget holds (`runtime/daily-spend-budget.ts`) are invisible
 * here, so two processes can together overshoot the ceiling by what they
 * have in flight. Each write is durable: the tmp file is flushed before
 * the atomic rename and the directory after it, so a power loss cannot
 * leave an empty file that would reset the day to zero.
 *
 * The day is the UTC calendar day starting at
 * `llm.costTracking.dailyResetHourUtc` (0-23, default 0): with 6, spend
 * at 05:59 UTC still belongs to the previous day and the total resets at
 * 06:00 UTC. A file from an earlier day reads as zero; it is replaced on
 * the next write.
 *
 * Same honesty rules as the session readout: only priced calls add to
 * `usd`; a cloud call with no known price is counted as unpriced, never
 * as $0. Local and plan-billed calls are not spend and are not counted.
 */
export interface DailySpendReading {
  /** The day this reading belongs to, `YYYY-MM-DD` (UTC, after the reset hour). */
  day: string;
  usd: number;
  pricedCalls: number;
  unpricedCalls: number;
}

/**
 * The readout's view of today: the reading, plus the ceiling when one is
 * set. Rides on the live `usage_updated` event as `SessionUsageState.today`;
 * never persisted with a session, because it is not the session's.
 */
export interface DailySpendView extends DailySpendReading {
  limitUsd?: number;
}

export const DAILY_SPEND_FILE_NAME = "daily-spend.json";

export interface DailySpendStoreOptions {
  path: string;
  /** UTC hour the day starts at (`llm.costTracking.dailyResetHourUtc`); read on every call. */
  resetHourUtc?: () => number;
  now?: () => number;
}

export class DailySpendStore {
  private readonly path: string;
  private readonly resetHourUtc: () => number;
  private readonly now: () => number;
  private cached: DailySpendReading | null = null;

  constructor(options: DailySpendStoreOptions) {
    this.path = options.path;
    this.resetHourUtc = options.resetHourUtc ?? (() => 0);
    this.now = options.now ?? Date.now;
  }

  /** Today's total, read from disk (another process may have added to it). */
  today(): DailySpendReading {
    const day = this.currentDay();
    const stored = this.read();
    const reading = stored && stored.day === day ? stored : emptyReading(day);
    this.cached = reading;
    return reading;
  }

  /**
   * Today's total without touching the disk: what this process last
   * read or wrote. For the readout, which runs on every usage event.
   */
  peek(): DailySpendReading {
    const day = this.currentDay();
    return this.cached && this.cached.day === day ? this.cached : this.today();
  }

  /** Fold one completion's price in. Local, plan and usage-less calls change nothing. */
  record(price: CompletionPrice): DailySpendReading {
    if (price.kind !== "priced" && price.kind !== "unpriced") return this.peek();
    return this.add(price.kind === "priced" ? price.usd : undefined);
  }

  /**
   * Add one paid call: `usd` when its price is known, otherwise one
   * unpriced call. The request budget's daily hold settles through here.
   */
  add(usd: number | undefined): DailySpendReading {
    const base = this.today();
    const next: DailySpendReading =
      usd !== undefined
        ? { ...base, usd: base.usd + usd, pricedCalls: base.pricedCalls + 1 }
        : { ...base, unpricedCalls: base.unpricedCalls + 1 };
    this.cached = next;
    this.write(next);
    return next;
  }

  private currentDay(): string {
    return spendDayKey(this.now(), this.resetHourUtc());
  }

  private read(): DailySpendReading | null {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<DailySpendReading>;
      if (typeof raw.day !== "string") return null;
      return {
        day: raw.day,
        usd: finiteOrZero(raw.usd),
        pricedCalls: finiteOrZero(raw.pricedCalls),
        unpricedCalls: finiteOrZero(raw.unpricedCalls),
      };
    } catch {
      return null;
    }
  }

  private write(reading: DailySpendReading): void {
    try {
      const dir = dirname(this.path);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${randomUUID()}.tmp`;
      // Flushed and unlinked on its own failure.
      writeFileSyncedSync(tmp, `${JSON.stringify(reading)}\n`, { mode: 0o600, flag: "wx" });
      try {
        renameWithRetrySync(tmp, this.path);
      } catch (err) {
        try {
          unlinkSync(tmp);
        } catch {
          // best effort: nothing more to do with a tmp file we cannot remove
        }
        throw err;
      }
      syncDirectoryBestEffort(dir);
    } catch {
      // A read-only state dir must not fail a completion. The total
      // still holds for this process (`cached`).
    }
  }
}

/**
 * The spend day `now` falls in: the UTC calendar day, starting at
 * `resetHourUtc` instead of midnight. Same rule as `CostAccumulator`.
 */
export function spendDayKey(now: number, resetHourUtc: number): string {
  const hour = Number.isFinite(resetHourUtc) ? Math.min(23, Math.max(0, Math.floor(resetHourUtc))) : 0;
  const d = new Date(now);
  if (d.getUTCHours() < hour) d.setUTCDate(d.getUTCDate() - 1);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

/** `dailyLimitUsd` when it is a usable ceiling; anything else is "no limit". */
export function effectiveDailyLimitUsd(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Is today's priced spend at or over the ceiling? */
export function isOverDailyLimit(reading: DailySpendReading, limitUsd: number | null): boolean {
  return limitUsd !== null && reading.usd >= limitUsd;
}

function emptyReading(day: string): DailySpendReading {
  return { day, usd: 0, pricedCalls: 0, unpricedCalls: 0 };
}

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Today's view for the readout, or `undefined` when the operator asked
 * for neither the day total (`showInStatusBar`) nor a ceiling
 * (`dailyLimitUsd`), or when no configured cloud link has a known price
 * (`pricedCloudLink`, ATO-649): the readout then stays exactly as it was.
 */
export function dailySpendViewFor(
  store: Pick<DailySpendStore, "peek">,
  costTracking: { showInStatusBar?: boolean; dailyLimitUsd?: number } | undefined,
  pricedCloudLink: () => boolean = () => true,
): DailySpendView | undefined {
  const limit = effectiveDailyLimitUsd(costTracking?.dailyLimitUsd);
  if (costTracking?.showInStatusBar !== true && limit === null) return undefined;
  if (!pricedCloudLink()) return undefined;
  const reading = store.peek();
  return limit === null ? reading : { ...reading, limitUsd: limit };
}
