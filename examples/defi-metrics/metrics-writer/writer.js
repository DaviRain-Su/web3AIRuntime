import fs from 'node:fs';
import path from 'node:path';

// Zero-dependency writer: upsert metrics into a JSON file.
// This avoids requiring Docker/Postgres during development.

const STORE_PATH =
  process.env.METRICS_STORE_PATH ||
  path.join(process.env.HOME || process.cwd(), '.w3rt', 'metrics', 'defi_metrics.json');

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function loadStore() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    const j = JSON.parse(raw);
    const metrics = Array.isArray(j?.metrics) ? j.metrics : [];
    return { metrics };
  } catch {
    return { metrics: [] };
  }
}

function saveStore(store) {
  ensureDir(STORE_PATH);
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function upsertMetric(metrics, row) {
  const idx = metrics.findIndex(
    (m) => m.chain === row.chain && m.protocol === row.protocol && m.market === row.market
  );
  if (idx >= 0) metrics[idx] = { ...metrics[idx], ...row };
  else metrics.push(row);
}

async function main() {
  const store = loadStore();
  const metrics = store.metrics;
  const now = new Date().toISOString();

  // v0 placeholders: define the two markets we agreed on.
  upsertMetric(metrics, {
    chain: 'solana',
    protocol: 'solend',
    market: 'main',
    tvl_usd: null,
    liquidity_usd: null,
    price_vol_5m_bps: null,
    borrow_utilization_bps: null,
    source_url: 'https://api.save.finance/v1/markets/configs?scope=all&deployment=production',
    updated_at: now,
  });

  upsertMetric(metrics, {
    chain: 'solana',
    protocol: 'meteora',
    market: 'dlmm:SOL/USDC',
    tvl_usd: null,
    liquidity_usd: null,
    price_vol_5m_bps: null,
    borrow_utilization_bps: null,
    source_url: 'https://meteora.ag (DLMM)',
    updated_at: now,
  });

  saveStore({ metrics });

  console.log(JSON.stringify({ ok: true, store: STORE_PATH, updated: metrics.length }));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
  process.exit(1);
});
