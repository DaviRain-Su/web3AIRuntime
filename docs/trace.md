# Trace Runtime

Trace provides **audit** + **debug** + **replay**.

## Storage layout (MVP)
- `.w3rt/runs/<runId>/trace.jsonl`
- `.w3rt/runs/<runId>/artifacts/*.json`

DB (Postgres) can be added later for multi-user hosting.

## Event model
Minimum events:
- `run.started`, `run.finished`
- `step.started`, `step.finished`
- `tool.called`, `tool.result`, `tool.error`
- `policy.decision`
- `tx.built`, `tx.simulated`, `tx.submitted`, `tx.confirmed`

Each event should include:
- `runId`, `stepId` (optional), `sessionId` (optional)
- `chain`, `walletId`
- `tool` name
- `data` (small)
- `artifactRefs` (for large payloads)

## Replay modes
- `replay --dry`: validate determinism and artifacts
- `replay --execute`: rerun with policy gates (never auto-broadcast on mainnet)
