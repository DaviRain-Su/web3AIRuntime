# Workflow Engine

Workflows are **the product**. Tools are just primitives.

## Workflow structure (from spec)
- `trigger`: manual | cron
- `stages`: ordered list of stages
- `stage.type`: analysis | simulation | approval | execution | monitor
- `when`: condition (MVP string, future JSON/CEL)

## Variable binding
We will support templating like:
- `{{ opportunity.sourceChain }}`
- `{{ steps.quote.output.quoteId }}`

Internally, resolve templates against a `RunContext` object.

## Approvals
Approval stages define:
- required
- timeout
- conditions (for auto-approval under strict policy)

## MVP workflow: Solana Jupiter swap
Stages:
1) quote
2) build
3) simulate
4) approve
5) execute
6) confirm/monitor

## Scheduler
- cron triggers create runs
- runs are queued
- each run is resumable
