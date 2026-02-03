import { Client } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/w3rt_metrics';
const SOLANA_YIELD_URL = process.env.SOLANA_YIELD_URL || 'https://solana-yield.vercel.app/api/yields';
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 5 * 60 * 1000);
const CHAIN = process.env.CHAIN || 'solana';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeProtocol(p) {
  return String(p || '').trim().toLowerCase();
}

function normalizeMarket(y) {
  // Prefer a stable identifier; fallback to asset.
  // solana-yield payload includes `pool` for many rows.
  return String(y.pool || y.asset || 'unknown').trim();
}

async function fetchSolanaYield() {
  const res = await fetch(SOLANA_YIELD_URL, {
    headers: { 'accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`solana-yield fetch failed: ${res.status} ${res.statusText}`);
  return await res.json();
}

async function upsertRows(client, rows, sourceUrl) {
  // Upsert per (chain, protocol, market)
  const text = `
    INSERT INTO defi_metrics (
      chain, protocol, market,
      tvl_usd, liquidity_usd,
      price_vol_5m_bps, borrow_utilization_bps,
      source_url, updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW())
    ON CONFLICT (chain, protocol, market)
    DO UPDATE SET
      tvl_usd = EXCLUDED.tvl_usd,
      liquidity_usd = EXCLUDED.liquidity_usd,
      price_vol_5m_bps = EXCLUDED.price_vol_5m_bps,
      borrow_utilization_bps = EXCLUDED.borrow_utilization_bps,
      source_url = EXCLUDED.source_url,
      updated_at = NOW()
  `;

  let n = 0;
  for (const r of rows) {
    await client.query(text, [
      CHAIN,
      r.protocol,
      r.market,
      r.tvl_usd,
      r.liquidity_usd,
      r.price_vol_5m_bps,
      r.borrow_utilization_bps,
      sourceUrl,
    ]);
    n++;
  }
  return n;
}

async function runOnce() {
  const payload = await fetchSolanaYield();
  const yields = Array.isArray(payload?.yields) ? payload.yields : [];

  const rows = yields
    .filter((y) => y && y.protocol)
    .map((y) => {
      const protocol = normalizeProtocol(y.protocol);
      const market = normalizeMarket(y);
      // solana-yield uses `tvl` (appears to be USD)
      const tvl = Number.isFinite(Number(y.tvl)) ? Number(y.tvl) : null;
      return {
        protocol,
        market,
        tvl_usd: tvl,
        liquidity_usd: null,
        price_vol_5m_bps: null,
        borrow_utilization_bps: null,
      };
    });

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const inserted = await upsertRows(client, rows, SOLANA_YIELD_URL);
    return { inserted, rows: rows.length };
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  // Simple long-running loop for sidecar usage.
  // Use RUN_ONCE=1 for a single iteration.
  const runOnceOnly = process.env.RUN_ONCE === '1';

  for (;;) {
    const started = Date.now();
    try {
      const r = await runOnce();
      const ms = Date.now() - started;
      console.log(
        `[solana-yield-ingest] ok rows=${r.rows} upserted=${r.inserted} duration_ms=${ms} source=${SOLANA_YIELD_URL}`
      );
    } catch (e) {
      console.error(`[solana-yield-ingest] error: ${String(e?.message ?? e)}`);
    }

    if (runOnceOnly) break;
    await sleep(INTERVAL_MS);
  }
}

main().catch((e) => {
  console.error(`[solana-yield-ingest] fatal: ${String(e?.message ?? e)}`);
  process.exit(1);
});
