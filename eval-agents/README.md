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
- `campaign.json` — selected, executed and skipped case counts

An intended campaign fails if its dataset/task filters select no rows, its
agent filter selects no adapters, or no selected agent case executes. Missing
competitor prerequisites remain genuine skipped tests with reasons in the
matrix; partial skips do not count as executed successes. The scorer-only
smoke is a separate hermetic unit test and does not establish agent execution.
Set `ATOMIC_AGENT_GAIA_REPORT_DIR` to place a campaign's reports in a chosen
directory (the default remains a timestamped directory under `reports/`).

## Methodology

- **Chat model**: shared `llama-server` URL for all agents.
- **atomic-agent**: memory fabric **on** (chat + embedding daemons when available).
- **Hermes / OpenClaw**: stock CLI, local OpenAI-compatible endpoint.
- **Prompt**: GAIA prefix + `FINAL ANSWER:` convention; scorer is deterministic.
- **Hermetic smoke**: `datasets/gaia/fixtures/smoke-level1.json` (no HF leak).

See [docs/PHASE0-COMPATIBILITY.md](docs/PHASE0-COMPATIBILITY.md) for research
notes and known risks.
