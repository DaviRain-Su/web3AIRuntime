import { Client } from 'pg';

// Minimal writer (v0): upsert placeholder rows for Solend + Meteora.
// Next step: replace placeholders with real on-chain/APIs (utilization, liquidity, vol).

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/w3rt_metrics';

async function upsert(client, row) {
  await client.query(
    `INSERT INTO defi_metrics
      (chain, protocol, market, tvl_usd, liquidity_usd, price_vol_5m_bps, borrow_utilization_bps, source_url, updated_at)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (chain, protocol, market)
     DO UPDATE SET
      tvl_usd=EXCLUDED.tvl_usd,
      liquidity_usd=EXCLUDED.liquidity_usd,
      price_vol_5m_bps=EXCLUDED.price_vol_5m_bps,
      borrow_utilization_bps=EXCLUDED.borrow_utilization_bps,
      source_url=EXCLUDED.source_url,
      updated_at=NOW();`,
    [
      row.chain,
      row.protocol,
      row.market,
      row.tvl_usd,
      row.liquidity_usd,
      row.price_vol_5m_bps,
      row.borrow_utilization_bps,
      row.source_url,
    ]
  );
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    // Solend: main market USDC reserve (we already use api.save.finance for config)
    await upsert(client, {
      chain: 'solana',
      protocol: 'solend',
      market: 'main',
      tvl_usd: null,
      liquidity_usd: null,
      price_vol_5m_bps: null,
      borrow_utilization_bps: null,
      source_url: 'https://api.save.finance/v1/markets/configs?scope=all&deployment=production',
    });

    // Meteora DLMM: SOL/USDC (placeholder)
    await upsert(client, {
      chain: 'solana',
      protocol: 'meteora',
      market: 'dlmm:SOL/USDC',
      tvl_usd: null,
      liquidity_usd: null,
      price_vol_5m_bps: null,
      borrow_utilization_bps: null,
      source_url: 'https://meteora.ag (DLMM)',
    });

    console.log(JSON.stringify({ ok: true, updated: 2 }));
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
  process.exit(1);
});
