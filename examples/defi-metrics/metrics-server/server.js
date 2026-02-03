import http from 'node:http';
import { Client } from 'pg';

const PORT = Number(process.env.PORT || 8789);
const HOST = String(process.env.HOST || '127.0.0.1');
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/w3rt_metrics';

function send(res, code, body) {
  const data = JSON.stringify(body, null, 2);
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(data);
}

async function withClient(fn) {
  const c = new Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true });
    }

    // GET /v1/metrics/get?chain=solana&protocol=solend&market=main
    if (req.method === 'GET' && url.pathname === '/v1/metrics/get') {
      const chain = url.searchParams.get('chain') || 'solana';
      const protocol = url.searchParams.get('protocol') || '';
      const market = url.searchParams.get('market') || '';
      if (!protocol || !market) return send(res, 400, { ok: false, error: 'MISSING_PARAMS' });

      const row = await withClient(async (c) => {
        const r = await c.query(
          'SELECT chain,protocol,market,tvl_usd,liquidity_usd,price_vol_5m_bps,borrow_utilization_bps,updated_at,source_url FROM defi_metrics WHERE chain=$1 AND protocol=$2 AND market=$3',
          [chain, protocol, market]
        );
        return r.rows[0] || null;
      });

      return send(res, 200, { ok: true, metric: row });
    }

    // GET /v1/metrics/list?chain=solana&limit=20
    if (req.method === 'GET' && url.pathname === '/v1/metrics/list') {
      const chain = url.searchParams.get('chain') || 'solana';
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 20)));

      const rows = await withClient(async (c) => {
        const r = await c.query(
          'SELECT chain,protocol,market,tvl_usd,liquidity_usd,price_vol_5m_bps,borrow_utilization_bps,updated_at FROM defi_metrics WHERE chain=$1 ORDER BY updated_at DESC LIMIT $2',
          [chain, limit]
        );
        return r.rows;
      });

      return send(res, 200, { ok: true, metrics: rows });
    }

    return send(res, 404, { ok: false, error: 'NOT_FOUND' });
  } catch (e) {
    return send(res, 500, { ok: false, error: 'INTERNAL', message: String(e?.message ?? e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`metrics-server listening on http://${HOST}:${PORT}`);
});
