import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// Zero-dependency mode: read metrics from a JSON file written by metrics-writer.
// This avoids requiring Docker/Postgres during development.

const PORT = Number(process.env.PORT || 8789);
const HOST = String(process.env.HOST || '127.0.0.1');

// File layout: { metrics: [ {chain,protocol,market,tvl_usd,liquidity_usd,price_vol_5m_bps,borrow_utilization_bps,source_url,updated_at} ] }
const STORE_PATH =
  process.env.METRICS_STORE_PATH ||
  path.join(process.env.HOME || process.cwd(), '.w3rt', 'metrics', 'defi_metrics.json');

function send(res, code, body) {
  const data = JSON.stringify(body, null, 2);
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(data);
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, store: 'json', storePath: STORE_PATH });
    }

    if (req.method === 'GET' && url.pathname === '/v1/metrics/get') {
      const chain = url.searchParams.get('chain') || 'solana';
      const protocol = url.searchParams.get('protocol') || '';
      const market = url.searchParams.get('market') || '';
      if (!protocol || !market) return send(res, 400, { ok: false, error: 'MISSING_PARAMS' });

      const { metrics } = loadStore();
      const row =
        metrics.find((m) => m?.chain === chain && m?.protocol === protocol && m?.market === market) || null;

      return send(res, 200, { ok: true, metric: row });
    }

    if (req.method === 'GET' && url.pathname === '/v1/metrics/list') {
      const chain = url.searchParams.get('chain') || 'solana';
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 20)));

      const { metrics } = loadStore();
      const rows = metrics
        .filter((m) => m?.chain === chain)
        .sort((a, b) => String(b?.updated_at ?? '').localeCompare(String(a?.updated_at ?? '')))
        .slice(0, limit);

      return send(res, 200, { ok: true, metrics: rows });
    }

    return send(res, 404, { ok: false, error: 'NOT_FOUND' });
  } catch (e) {
    return send(res, 500, { ok: false, error: 'INTERNAL', message: String(e?.message ?? e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`metrics-server listening on http://${HOST}:${PORT} (json store: ${STORE_PATH})`);
});
