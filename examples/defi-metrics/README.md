# DeFi Metrics (CocoIndex + Postgres) — w3rt sidecar example

Goal: maintain a fresh, queryable DeFi metrics store (TVL / liquidity / price volatility / borrow utilization) for w3rt planning + policy gating.

This folder is an **example sidecar**. It is not required to build w3rt.

## Architecture

**Phase 0 (no Docker / no Postgres):** JSON store for quick iteration.

```
metrics-writer (json)  ->  ~/.w3rt/metrics/defi_metrics.json  ->  metrics-server(HTTP)  ->  w3rt tools
```

**Phase 1 (CocoIndex + Postgres):** incremental processing + lineage.

```
CocoIndex flow  ->  Postgres(defi_metrics)  ->  metrics-server(HTTP)  ->  w3rt tools
```

w3rt queries metrics via `W3RT_METRICS_URL`.

## What we track (v0)

- `tvl_usd`
- `liquidity_usd`
- `price_vol_5m_bps` (rolling 5m volatility in bps)
- `borrow_utilization_bps`

## Metrics writer (5-minute refresh)

Writes placeholder rows (v0) for:
- `solend / main`
- `meteora / dlmm:SOL/USDC`

Run once:

```bash
cd examples/defi-metrics/metrics-writer
node writer.js
```

To run every 5 minutes, use cron/systemd (example crontab):

```cron
*/5 * * * * /usr/bin/node /path/to/web3AIRuntime/examples/defi-metrics/metrics-writer/writer.js >> /tmp/w3rt-metrics-writer.log 2>&1
```

The writer outputs to a JSON store (default):
- `~/.w3rt/metrics/defi_metrics.json`

Override path with:
- `METRICS_STORE_PATH=/some/path.json`

## Metrics server

```bash
cd examples/defi-metrics/metrics-server
node server.js
```

Health:
```bash
curl -s http://127.0.0.1:8789/health
```

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
