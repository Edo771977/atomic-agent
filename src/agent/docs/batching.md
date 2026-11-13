# Step batching and terminal behavior

Status: current
Owner: src/agent/

## Pipeline

One inference produces an array of calls. Production GBNF is array-only; legacy replay parsing can accept a bare object. The grammar ceiling is 16 calls; the runtime soft cap comes from configuration.

Validation rejects forbidden multi-call combinations. A terminal can occur only once, at the tail. Single-call arrays retain solo semantics. Approval posture and resource class both matter: the initial validator rejects gated multi-call combinations, but the executor can run an eligible unattended wave in emitted order, or run an eligible interactive batch behind approval barriers. Batchable calls settle before each gated call runs alone; after a denied or failed barrier, later calls do not run and receive explicit not-run results. The step reports the original indices, timing and barrier outcome, and gives the next inference a notice rather than asking it to regenerate successful calls. Forced final steps, plan/fusion restrictions, unknown or schema-invalid tools, and tools solo for non-approval reasons retain the trim/repair policy. Each invocation still passes through its real approval gate. fusion.delegate stays solo regardless of grants; consult isBatchable, gatedCallRunsUnattended and the executor together rather than a historical name list.

The executor synchronously checks and records non-terminal calls in index order before invocation, so a duplicate sibling sees the earlier call. It then groups survivors by resource class. Pure reads fan out inside their group; serial resource groups run in order. Outcomes and state effects retain batch-index order regardless of completion order.

A turn's `toolFilter` is also a dispatch boundary: after canonical name resolution, excluded non-terminal calls receive an error without invoking the registry, hooks, loop accounting or cached-skill shortcuts. Approval-batch eligibility and trim use the same admission predicate before selecting a survivor; when the filter excludes every gated candidate, an allowed read can survive instead. Trim still reports refused calls through its event and transient notice and executes one survivor; ordinary dispatch retains each emitted result slot. This applies equally to native calls and calls recovered from content or reasoning, even if the provider ignores the request grammar. The same predicate reaches `tool.view`, which refuses excluded discovery targets, and `tool.search`, which omits them before ranking, limiting hits or loading schemas. Allowed rare and out-of-role discovery is unchanged. `reply` and `finish` retain their own-session terminal behavior, including a worker finishing its throwaway session.

A tail terminal waits for non-terminal groups. A tool error does not cancel siblings or suppress that terminal. Terminals are never loop-gated. Cancellation must stop remaining serial work. Once a cancellation is seen, the batch waits for groups still running for at most `BATCH_CANCEL_GRACE_MS` (a few seconds), so a tool that ignores the signal cannot hold the step or the session lock; calls still running then read cancelled, and the batch is closed: a late result writes no slot and fires no `onCallFinished`. When the turn's signal is aborted the batch reports cancelled even if another group failed with a non-cancel error; that error is rethrown only for a batch that was not cancelled.

## Reply versus progress

On an ordinary step, a reply batched with actual work can be extracted as a progress note and leave the turn open. Forced terminal steps and bookkeeping-only closing batches have separate rules; do not apply the terminal barrier alone to decide turn completion. Append tool/result pairs before the final assistant reply and emit the reply once.

## Sources and tests

- [Step orchestration](../step-executor.ts), [batch policy](../step/step-batch-policy.ts), [admission](../step/step-evidence.ts), [ordered commit](../step/step-commit.ts), [synchronous gates](../dispatch/batch-gates.ts), [scheduler](../dispatch/batch-scheduler.ts), [resource classes](../tool-resource-class.ts), [progress note policy](../progress-note-reply.ts).
- [Batch tests](../batch-executor.test.ts), [step tests](../step-executor.test.ts), [class completeness](../tool-resource-class.test.ts).
