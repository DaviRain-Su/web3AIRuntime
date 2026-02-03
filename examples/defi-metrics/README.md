# DeFi Metrics (CocoIndex + Postgres) — w3rt sidecar example

Goal: maintain a fresh, queryable DeFi metrics store (TVL / liquidity / price volatility / borrow utilization) for w3rt planning + policy gating.

This folder is an **example sidecar**. It is not required to build w3rt.

## Architecture

- **CocoIndex** (python) runs an incremental dataflow and exports into Postgres.
- A tiny **metrics HTTP server** exposes read-only endpoints for w3rt.
- w3rt queries metrics via `W3RT_METRICS_URL`.

```
CocoIndex flow  ->  Postgres(defi_metrics)  ->  metrics-server(HTTP)  ->  w3rt tools
```

## What we track (v0)

- `tvl_usd`
- `liquidity_usd`
- `price_vol_5m_bps` (rolling 5m volatility in bps)
- `borrow_utilization_bps`

## Run Postgres

```bash
cd examples/defi-metrics
docker compose up -d
```

This starts Postgres on `localhost:5432` with db `w3rt_metrics`.

## Initialize schema

```bash
psql postgresql://postgres:postgres@localhost:5432/w3rt_metrics -f sql/schema.sql
```

## Metrics writer (5-minute refresh)

A tiny writer process upserts metrics rows into Postgres. For now it writes placeholder rows for:
- `solend / main`
- `meteora / dlmm:SOL/USDC`

Run once:

```bash
cd examples/defi-metrics/metrics-writer
npm install
npm run run
```

To run every 5 minutes, use cron/systemd (example crontab):

```cron
*/5 * * * * cd /path/to/web3AIRuntime/examples/defi-metrics/metrics-writer && /usr/bin/npm run -s run >> /tmp/w3rt-metrics-writer.log 2>&1
```

> Next step: replace placeholders with real values (TVL/liquidity/vol/utilization) from on-chain + protocol APIs.

## Metrics server

```bash
cd metrics-server
npm install
npm start
```

Server listens on `http://127.0.0.1:8789`.

## Configure w3rt

```bash
export W3RT_METRICS_URL=http://127.0.0.1:8789
```

w3rt tools (planned):
- `metrics_get` (protocol/market)
- `metrics_list` (topN, sortBy)

## SolanaYield ingest (quick data source)

This example includes a minimal ingest loop that pulls from SolanaYield and upserts into Postgres every 5 minutes.

It fills **tvl_usd** and leaves other fields null (volatility/utilization can be added by additional ingestors).

### Run (via docker compose)

```bash
cd examples/defi-metrics
docker compose up -d
```

### One-shot run (debug)

```bash
cd examples/defi-metrics/ingest
npm install
RUN_ONCE=1 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/w3rt_metrics node solana-yield-ingest.js
```

## CocoIndex flow (placeholder)

See `cocoindex/flow.py` for a placeholder flow definition.

> Note: this repo currently doesn’t ship python in CI; CocoIndex is used as a sidecar.
