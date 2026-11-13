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
 * Asked at most once per (server, model, profile) for the process: a
 * pass or a failure is kept under the probe's `key`; a timeout, a
 * cancel or an unreachable server keeps nothing, so the next fan-out
 * asks again. Not asked on a leg where a worker already finished with a
 * tool call this session: that is the same answer, measured. Only a
 * local leg with a probe is ever asked (the runtime wires one for the
 * main local server alone), never a cloud leg, and the check is off with
 * `llm.runMode.fusion.localFormatCheck: false`.
 *
 * One instance per `fusion.delegate` tool, i.e. per runtime.
 */
export interface LocalGrammarProbe {
  /** What answers: server URL, model id and profile id, joined. */
  key: string;
  run: (signal?: AbortSignal) => Promise<GrammarSmokeVerdict>;
}

export type LocalGrammarCheck =
  | (GrammarSmokeVerdict & { cached: boolean })
  | { kind: "skipped"; why: "worker-succeeded" | "cancelled" };

export class LocalGrammarSmoke {
  private readonly verdicts = new Map<string, Promise<GrammarSmokeVerdict>>();
  private readonly succeeded = new Set<string>();

  /** A worker on `leg` finished with at least one tool call, in `sessionId`. */
  noteWorkerSucceeded(sessionId: string, leg: string): void {
    this.succeeded.add(legKey(sessionId, leg));
  }

  async check(
    probe: LocalGrammarProbe,
    at: { sessionId: string; leg: string; signal?: AbortSignal },
  ): Promise<LocalGrammarCheck> {
    if (this.succeeded.has(legKey(at.sessionId, at.leg))) {
      return { kind: "skipped", why: "worker-succeeded" };
    }
    if (at.signal?.aborted) return { kind: "skipped", why: "cancelled" };
    const known = this.verdicts.get(probe.key);
    if (known !== undefined) return { ...(await known), cached: true };
    const pending = probe.run(at.signal).catch(
      (err: unknown): GrammarSmokeVerdict => ({
        kind: "inconclusive",
        reason: "unreachable",
        detail: err instanceof Error ? err.message : String(err),
      }),
    );
    // Shared while in flight, so two fan-outs at once ask once.
    this.verdicts.set(probe.key, pending);
    const verdict = await pending;
    if (verdict.kind === "inconclusive" && this.verdicts.get(probe.key) === pending) {
      this.verdicts.delete(probe.key);
    }
    return { ...verdict, cached: false };
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
  return `fusion.delegate did not run: ${describeTrip(trip)}. Before any worker started, a one-call format check on ${model} under the workers' own grammar failed: ${error}. ${FAILURE_BREAKER_INSTRUCTION}`;
}
