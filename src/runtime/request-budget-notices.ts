import type { AgentLoopEvent } from "../agent/agent-contract.js";
import type { CompletionRequest } from "../llm/provider/completion-types.js";
import type { RequestBudgetScope } from "./request-budget.js";

interface NoticeTurn {
  readonly sessionId: string;
  readonly seen: Set<string>;
  active: boolean;
}

/** User-facing budget advice belongs to the request's owning turn, including its workers. */
export class RequestBudgetNotices {
  private readonly turns = new Map<string, NoticeTurn>();
  private readonly workers = new Map<string, NoticeTurn>();

  constructor(private readonly emit: (sessionId: string, event: AgentLoopEvent) => void) {}

  begin(sessionId: string): () => void {
    const previous = this.turns.get(sessionId);
    if (previous !== undefined) this.close(previous);
    const turn: NoticeTurn = { sessionId, seen: new Set(), active: true };
    this.turns.set(sessionId, turn);
    return () => this.close(turn);
  }

  bind(workerSessionId: string, parentSessionId: string): () => void {
    const turn = this.turns.get(parentSessionId);
    if (turn === undefined) return () => {};
    this.workers.set(workerSessionId, turn);
    return () => {
      if (this.workers.get(workerSessionId) === turn) this.workers.delete(workerSessionId);
    };
  }

  private close(turn: NoticeTurn): void {
    turn.active = false;
    turn.seen.clear();
    if (this.turns.get(turn.sessionId) === turn) this.turns.delete(turn.sessionId);
    for (const [id, owner] of this.workers) if (owner === turn) this.workers.delete(id);
  }

  /** Observe initial metering advice and advice the final physical body determines. */
  observeScope(providerId: string, request: CompletionRequest, scope: RequestBudgetScope | undefined): RequestBudgetScope | undefined {
    if (scope === undefined) return undefined;
    const ownerId = request.budgetOwnerSessionId ?? request.sessionId;
    const turn = ownerId === undefined ? undefined : this.turns.get(ownerId) ?? this.workers.get(ownerId);
    if (turn === undefined) return scope;
    const report = (): void => {
      if (!turn.active || scope.hint === undefined || scope.hintReason === undefined) return;
      const key = `${providerId}:${scope.hintReason}`;
      if (turn.seen.has(key)) return;
      turn.seen.add(key);
      // Presentation failures cannot deny an otherwise affordable physical send.
      try {
        this.emit(turn.sessionId, { type: "budget_notice", sessionId: turn.sessionId, providerId,
          reason: scope.hintReason, text: scope.hint });
      } catch { /* the host owns failed presentation */ }
    };
    report();
    const beforeSend = scope.beforeSend.bind(scope);
    scope.beforeSend = body => {
      try { beforeSend(body); } finally { report(); }
    };
    return scope;
  }
}
