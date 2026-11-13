import type { GrammarSmokeVerdict } from "../../llm/grammar/grammar-smoke.js";
import {
  FAILURE_BREAKER_INSTRUCTION,
  TOOL_PROTOCOL_LABEL,
  TOOL_PROTOCOL_SIGNATURE,
  describeTrip,
  type BreakerTrip,
} from "./failure-breaker.js";

/**
 * The local worker leg's format check, before the first fan-out sends
 * workers there.
 *
 * A worker model that cannot produce the agent's tool-call format is
 * caught by the failure breaker only once a worker on it has failed
 * that way, after spending its time. `runGrammarSmoke`
 * (`llm/grammar/grammar-smoke.ts`) asks the same question with one
 * completion of a few dozen tokens under the workers' own per-request
 * grammar; a reply that does not parse refuses the fan-out up front,
 * with the breaker's own protocol-mismatch words and instruction, and
 * the trip is noted on the turn like any blocker.
 *
 * Asked at most once per (server, model, profile, server launch): a
 * pass is kept under the probe's `key` for the process, a failure for
 * {@link FORMAT_CHECK_FAIL_TTL_MS} (an upgraded server behind the same
 * URL is asked again once it runs out, and a managed daemon's restart
 * changes the key at once); a timeout, a cancel or an unreachable server
 * keeps nothing, so the next fan-out asks again. A probe whose model id
 * is unknown has no `key` and keeps nothing either: an unmanaged server
 * that swaps its model would otherwise share one verdict between models.
 * Not asked on a leg where a worker already finished with a tool call
 * this session: that is the same answer, measured — and it drops a
 * failure kept for that leg. Only a local leg with a probe is ever asked
 * (the runtime wires one for the main local server alone), never a
 * cloud leg, and the check is off with
 * `llm.runMode.fusion.localFormatCheck: false`.
 *
 * One instance per `fusion.delegate` tool, i.e. per runtime.
 */
export interface LocalGrammarProbe {
  /**
   * What answers: server URL, model id, profile id and the server's
   * launch generation, joined. `null` when the model id is unknown:
   * the verdict is then never kept.
   */
  key: string | null;
  run: (signal?: AbortSignal) => Promise<GrammarSmokeVerdict>;
}

export type LocalGrammarCheck =
  | (GrammarSmokeVerdict & { cached: boolean })
  | { kind: "skipped"; why: "worker-succeeded" | "cancelled" };

/** How long a failed check is kept: an upgraded server gets asked again. */
export const FORMAT_CHECK_FAIL_TTL_MS = 10 * 60_000;

interface KeptVerdict {
  pending: Promise<GrammarSmokeVerdict>;
  /** `Infinity` while in flight and for a pass. */
  expiresAt: number;
  /** Set once settled. */
  settled?: GrammarSmokeVerdict;
}

export class LocalGrammarSmoke {
  private readonly verdicts = new Map<string, KeptVerdict>();
  private readonly succeeded = new Set<string>();
  /** The keys each leg was checked under, so a worker's success can clear a failure. */
  private readonly legKeys = new Map<string, Set<string>>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /**
   * A worker on `leg` finished with at least one tool call, in
   * `sessionId`: that leg is not asked again in the session, and a
   * failure kept for it is dropped, since the format was just produced.
   */
  noteWorkerSucceeded(sessionId: string, leg: string): void {
    this.succeeded.add(legKey(sessionId, leg));
    for (const key of this.legKeys.get(leg) ?? []) {
      if (this.verdicts.get(key)?.settled?.kind === "fail") this.verdicts.delete(key);
    }
  }

  async check(
    probe: LocalGrammarProbe,
    at: { sessionId: string; leg: string; signal?: AbortSignal },
  ): Promise<LocalGrammarCheck> {
    if (this.succeeded.has(legKey(at.sessionId, at.leg))) {
      return { kind: "skipped", why: "worker-succeeded" };
    }
    if (at.signal?.aborted) return { kind: "skipped", why: "cancelled" };
    const key = probe.key;
    if (key === null) return { ...(await ask(probe, at.signal)), cached: false };
    let keys = this.legKeys.get(at.leg);
    if (keys === undefined) this.legKeys.set(at.leg, (keys = new Set()));
    keys.add(key);
    const known = this.verdicts.get(key);
    if (known !== undefined && known.expiresAt > this.now()) {
      return { ...(await known.pending), cached: true };
    }
    // Shared while in flight, so two fan-outs at once ask once.
    const kept: KeptVerdict = { pending: ask(probe, at.signal), expiresAt: Number.POSITIVE_INFINITY };
    this.verdicts.set(key, kept);
    const verdict = await kept.pending;
    if (this.verdicts.get(key) === kept) {
      if (verdict.kind === "inconclusive") {
        this.verdicts.delete(key);
      } else {
        kept.settled = verdict;
        if (verdict.kind === "fail") kept.expiresAt = this.now() + FORMAT_CHECK_FAIL_TTL_MS;
      }
    }
    return { ...verdict, cached: false };
  }
}

function ask(probe: LocalGrammarProbe, signal: AbortSignal | undefined): Promise<GrammarSmokeVerdict> {
  return probe.run(signal).catch(
    (err: unknown): GrammarSmokeVerdict => ({
      kind: "inconclusive",
      reason: "unreachable",
      detail: err instanceof Error ? err.message : String(err),
    }),
  );
}

function legKey(sessionId: string, leg: string): string {
  return `${sessionId}\u0000${leg}`;
}

/** The trip a failed check stands for: the breaker's tool-protocol blocker. */
export function formatCheckTrip(providerId: string): BreakerTrip {
  return {
    signature: TOOL_PROTOCOL_SIGNATURE,
    blocker: true,
    label: TOOL_PROTOCOL_LABEL,
    count: 1,
    providerId,
  };
}

/** The refusal the orchestrator reads, in the breaker's words. */
export function describeFormatCheckRefusal(trip: BreakerTrip, error: string, model: string): string {
  return `fusion.delegate did not run: ${describeTrip(trip)}. Before any worker started, a one-call format check on ${model} under the workers' own grammar failed: ${error}. ${FAILURE_BREAKER_INSTRUCTION}`;
}
