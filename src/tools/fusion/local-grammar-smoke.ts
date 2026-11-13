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
 * (`llm/grammar/grammar-smoke.ts`) sends one completion of a few dozen
 * tokens under a worker step's per-request grammar (its thinking
 * decision, reasoning prelude and tool set, the think bound tightened to
 * fit). Only a definite answer refuses the fan-out up front — the
 * server rejected the workers' grammar, or a reply that finished did
 * not parse with the step's parser — with the breaker's own
 * protocol-mismatch words and instruction, and the trip is noted on the
 * turn like any blocker. It checks that server, grammar, framing and
 * parser agree, not that the model does useful work.
 *
 * Asked at most once per (server, model, profile, server launch): a
 * pass is kept under the probe's `key` for the process, a failure for
 * {@link FORMAT_CHECK_FAIL_TTL_MS} (an upgraded server behind the same
 * URL is asked again once it runs out, and a managed daemon's restart
 * changes the key at once); a timeout, an unreachable server or a cut
 * reply is kept for {@link FORMAT_CHECK_INCONCLUSIVE_TTL_MS}, so a busy
 * or slow server is not asked before every fan-out, and a cancel keeps
 * nothing. Not asked at all while a fan-out this process started is
 * live on the same server, or while the server's `/slots` shows every
 * slot working: the check would queue behind those workers and say
 * nothing about the format (`skipped`, nothing kept). A probe whose model id
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
  /** The server asked (its URL): what a live fan-out is counted against. */
  server: string;
  run: (signal?: AbortSignal) => Promise<GrammarSmokeVerdict>;
  /** Whether every request slot on the server is working right now; absent: not known. */
  allSlotsBusy?: () => Promise<boolean>;
}

export type LocalGrammarCheck =
  | (GrammarSmokeVerdict & { cached: boolean })
  | { kind: "skipped"; why: "worker-succeeded" | "cancelled" | "server-busy" };

/** How long a failed check is kept: an upgraded server gets asked again. */
export const FORMAT_CHECK_FAIL_TTL_MS = 10 * 60_000;

/** How long a check with no verdict (timeout, unreachable, cut reply) is kept. */
export const FORMAT_CHECK_INCONCLUSIVE_TTL_MS = 2 * 60_000;

interface KeptVerdict {
  verdict: GrammarSmokeVerdict;
  /** `Infinity` for a pass. */
  expiresAt: number;
}

export class LocalGrammarSmoke {
  private readonly verdicts = new Map<string, KeptVerdict>();
  /** Checks in flight, shared so two fan-outs at once ask once. */
  private readonly inFlight = new Map<string, Promise<LocalGrammarCheck>>();
  private readonly succeeded = new Set<string>();
  /** The keys each leg was checked under, so a worker's success can clear a failure. */
  private readonly legKeys = new Map<string, Set<string>>();
  /** Fan-outs running now, per server. */
  private readonly live = new Map<string, number>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /**
   * A fan-out started sending workers to `servers`; the returned call
   * ends it. While one is live, a check on those servers is skipped.
   */
  beginFanout(servers: Iterable<string>): () => void {
    const held = [...new Set(servers)];
    for (const server of held) this.live.set(server, (this.live.get(server) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      for (const server of held) {
        const left = (this.live.get(server) ?? 1) - 1;
        if (left > 0) this.live.set(server, left);
        else this.live.delete(server);
      }
    };
  }

  /**
   * A worker on `leg` finished with at least one tool call, in
   * `sessionId`: that leg is not asked again in the session, and a
   * failure kept for it is dropped, since the format was just produced.
   */
  noteWorkerSucceeded(sessionId: string, leg: string): void {
    this.succeeded.add(legKey(sessionId, leg));
    for (const key of this.legKeys.get(leg) ?? []) {
      if (this.verdicts.get(key)?.verdict.kind === "fail") this.verdicts.delete(key);
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
    if (key === null) return this.ask(probe, at.signal);
    let keys = this.legKeys.get(at.leg);
    if (keys === undefined) this.legKeys.set(at.leg, (keys = new Set()));
    keys.add(key);
    const known = this.verdicts.get(key);
    if (known !== undefined && known.expiresAt > this.now()) {
      return { ...known.verdict, cached: true };
    }
    const flying = this.inFlight.get(key);
    if (flying !== undefined) {
      const shared = await flying;
      return shared.kind === "skipped" ? shared : { ...shared, cached: true };
    }
    const asked = this.ask(probe, at.signal);
    this.inFlight.set(key, asked);
    try {
      const checked = await asked;
      const ttl =
        checked.kind === "pass"
          ? Number.POSITIVE_INFINITY
          : checked.kind === "fail"
            ? FORMAT_CHECK_FAIL_TTL_MS
            : checked.kind === "inconclusive" && checked.reason !== "cancelled"
              ? FORMAT_CHECK_INCONCLUSIVE_TTL_MS
              : null;
      if (ttl !== null && checked.kind !== "skipped") {
        const { cached: _cached, ...verdict } = checked;
        this.verdicts.set(key, { verdict, expiresAt: this.now() + ttl });
      }
      return checked;
    } finally {
      if (this.inFlight.get(key) === asked) this.inFlight.delete(key);
    }
  }

  /** One run of the probe, unless the server is busy with workers. */
  private async ask(probe: LocalGrammarProbe, signal: AbortSignal | undefined): Promise<LocalGrammarCheck> {
    if ((this.live.get(probe.server) ?? 0) > 0 || (await allBusy(probe))) {
      return { kind: "skipped", why: "server-busy" };
    }
    const verdict = await probe.run(signal).catch(
      (err: unknown): GrammarSmokeVerdict => ({
        kind: "inconclusive",
        reason: "unreachable",
        detail: err instanceof Error ? err.message : String(err),
      }),
    );
    return { ...verdict, cached: false };
  }
}

/** A slot table that cannot be read says nothing: the check runs. */
async function allBusy(probe: LocalGrammarProbe): Promise<boolean> {
  try {
    return (await probe.allSlotsBusy?.()) === true;
  } catch {
    return false;
  }
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
  return `fusion.delegate did not run: ${describeTrip(trip)}. Before any worker started, the local format check (one short completion on ${model} under the workers' grammar) found: ${error}. ${FAILURE_BREAKER_INSTRUCTION}`;
}
