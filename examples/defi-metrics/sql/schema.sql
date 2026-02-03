CREATE TABLE IF NOT EXISTS defi_metrics (
  id BIGSERIAL PRIMARY KEY,
  chain TEXT NOT NULL DEFAULT 'solana',
  protocol TEXT NOT NULL,
  market TEXT NOT NULL,
  tvl_usd DOUBLE PRECISION,
  liquidity_usd DOUBLE PRECISION,
  price_vol_5m_bps DOUBLE PRECISION,
  borrow_utilization_bps DOUBLE PRECISION,
  source_url TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(chain, protocol, market)
);

CREATE INDEX IF NOT EXISTS idx_defi_metrics_updated_at ON defi_metrics(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_defi_metrics_protocol ON defi_metrics(protocol);
