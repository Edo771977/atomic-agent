# eval-agents — multi-agent GAIA benchmark

Compare **atomic-agent**, **Hermes**, and **OpenClaw** on the same local chat
model (default campaign: `gemma-4-26b-a4b`) using the public **GAIA**
validation split. Scoring uses the official GAIA `question_scorer`
normalization (exact match).

## Prerequisites

- `npm run build` (eval spawns `dist/cli/index.js` for atomic-agent).
- Managed llama daemons **or** `ATOMIC_AGENT_EVAL_LLAMA_URL`.
- For atomic-agent memory fabric: embedding daemon on port `19092` (started
  by `atomic-agent models start` when an embedding model is configured).
- Competitors: `hermes` and `openclaw` on `PATH` (skipped automatically when
  missing).
- Full GAIA (not smoke): `HF_TOKEN` + `npm run eval:agents:datasets`.

```bash
cp eval-agents/.env.example eval-agents/.env
# edit tokens / URLs
```

## Running

Unit tests (scoring + parsing, no LLM):

```bash
npm run eval:agents:lint
npx vitest run --config eval-agents/vitest.hermetic.config.ts
```

This config selects harness, adapter and launcher unit tests, plus `eval/`
unit tests. It excludes live `*.eval.ts` campaigns and the separate
`small-models/` task-fixture utilities, which currently require POSIX/Python
commands and are not part of this portable harness check.

Smoke (committed fixtures, all agents):

```bash
npm run eval:agents:smoke
```

GAIA validation Level 1 (real dataset):

```bash
npm run eval:agents:datasets   # once
npm run eval:agents:level1
```

Filter agents:

```bash
ATOMIC_AGENT_EVAL_AGENTS=atomic-agent npm run eval:agents:smoke
```

Scorecard:

```bash
npm run eval:agents:scorecard
```

## Reports

Each run writes `eval-agents/reports/run-<ISO>/`:

- `matrix.csv` / `matrix.jsonl` — per (agent × question) row
- `environment.json` — pinned model, sampling, git SHA
- `campaign.json` — selected, attempted, completed, failed and skipped case
  counts, plus report-write errors and case error provenance. `executed` is
  retained as an alias of `attempted`: an adapter invocation that throws is
  still an execution. `completed` counts adapter calls that returned;
  `failed` counts case errors/wrong answers separately from report failures.
  An exception gets a failed JSONL/CSV case row; independent matrix writers
  preserve whichever output remains writable. Counters are saved before
  matrix writes, and an unusable summary destination also emits them to stderr.

An intended campaign fails if its dataset/task filters select no rows, its
agent filter selects no adapters, or no selected agent case executes. Missing
competitor prerequisites remain genuine skipped tests with reasons in the
matrix; partial skips do not count as executed successes. The scorer-only
smoke is a separate hermetic unit test and does not establish agent execution.
The campaign config runs only `gaia.eval.ts`; its runner checks completion
outside test hooks, so a title filter matching nothing fails too. The
orchestrator independently validates its fresh completion report after Vitest
closes. An absent agent filter selects defaults; an explicitly empty string
or comma-only filter selects no agents and fails.
Set `ATOMIC_AGENT_GAIA_REPORT_DIR` to place a campaign's reports in a chosen
directory (the default remains a timestamped directory under `reports/`;
an empty value counts as unset, in the launcher and in `gaia.eval.ts`).
The launcher resolves a relative report directory against the test child's
working directory (normally the repository root), then passes the same
absolute path to the child and completion validator.

Orchestrators launch the installed Vitest JavaScript entry with the current
Node executable, including on Windows; forwarded arguments stay separate
argv entries. Spawn errors fail the run, and cancellation waits for the
test child to close before returning. On POSIX the test child leads its own
process group (stdin is not inherited): cancellation signals the whole group,
so Vitest's forked workers and the agents they started stop too, and the
launcher waits until the group is gone, escalating to SIGKILL after a timeout
(10 s by default). A group left behind after a normal exit is stopped the
same way. On Windows cancellation runs `taskkill /T`, then `/T /F` after the
timeout; it reaches descendants only while the Vitest process is alive.
Installed SIGINT/SIGTERM handlers request cancellation through the signal
passed by smoke/level1; they do not exit or stop daemons inline. The caller
awaits child close, then its managed-daemon teardown, before exiting 130
(SIGINT) or 143 (SIGTERM). A second signal does not wait: it SIGKILLs the
running test process tree and exits at once with the second signal's code,
skipping daemon teardown.
Health waits honor the same signal, and handlers are removed after teardown.

## Methodology

- **Chat model**: shared `llama-server` URL for all agents.
- **atomic-agent**: memory fabric **on** (chat + embedding daemons when available).
- **Hermes / OpenClaw**: stock CLI, local OpenAI-compatible endpoint.
- **Prompt**: GAIA prefix + `FINAL ANSWER:` convention; scorer is deterministic.
- **Hermetic smoke**: `datasets/gaia/fixtures/smoke-level1.json` (no HF leak).

See [docs/PHASE0-COMPATIBILITY.md](docs/PHASE0-COMPATIBILITY.md) for research
notes and known risks.
