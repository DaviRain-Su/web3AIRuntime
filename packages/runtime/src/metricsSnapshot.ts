import { readFileSync } from "node:fs";
import { join } from "node:path";

export type DefiMetricRow = {
  chain: string;
  protocol: string;
  market: string;
  tvl_usd?: number | null;
  liquidity_usd?: number | null;
  price_vol_5m_bps?: number | null;
  borrow_utilization_bps?: number | null;
  updated_at?: string;
  source_url?: string;
};

export type MetricsSnapshot = {
  // Index by a stable key for policy rules.
  // Keys are normalized to: `${protocol}_${market}` where market slashes/colons become underscores.
  index: Record<string, DefiMetricRow>;
  raw?: any;
};

function keyFor(protocol: string, market: string) {
  const normMarket = String(market)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${String(protocol).toLowerCase()}_${normMarket}`;
}

export function loadMetricsSnapshot(w3rtDir: string): MetricsSnapshot {
  const p = join(w3rtDir, "metrics", "defi_metrics.json");
  try {
    const raw = readFileSync(p, "utf-8");
    const j = JSON.parse(raw);
    const rows: DefiMetricRow[] = Array.isArray(j?.metrics) ? j.metrics : [];

    const index: Record<string, DefiMetricRow> = {};
    for (const r of rows) {
      if (!r?.protocol || !r?.market) continue;
      index[keyFor(r.protocol, r.market)] = r;
    }

    return { index, raw: j };
  } catch {
    return { index: {} };
  }
}
