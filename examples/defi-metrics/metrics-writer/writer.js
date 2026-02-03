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
    const history = j?.history && typeof j.history === 'object' ? j.history : {};
    return { metrics, history };
  } catch {
    return { metrics: [], history: {} };
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

import { fetchSolendUsdcReserveState } from './solend_util.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { parsePriceData } from '@pythnetwork/client';

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function fetchSolUsdPrice(opts) {
  // Use on-chain Pyth price account (no external HTTP / no API key).
  const rpcUrl = opts?.rpcUrl || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const pythOracle = opts?.pythOracle;
  if (!pythOracle) throw new Error('MISSING_PYTH_ORACLE');

  const conn = new Connection(rpcUrl, 'confirmed');
  const acc = await conn.getAccountInfo(new PublicKey(pythOracle));
  if (!acc?.data) throw new Error('PYTH_ACCOUNT_NOT_FOUND');

  const priceData = parsePriceData(acc.data);
  const price = Number(priceData?.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error('PRICE_NOT_FOUND');

  return {
    price,
    source_url: `solana:${pythOracle}`,
  };
}

function pushHistory(history, key, point, maxPoints = 24) {
  const arr = Array.isArray(history[key]) ? history[key] : [];
  arr.push(point);
  // keep last maxPoints
  history[key] = arr.slice(-maxPoints);
}

function computeVolBpsFromLastTwo(history, key) {
  const arr = Array.isArray(history[key]) ? history[key] : [];
  if (arr.length < 2) return null;
  const a = arr[arr.length - 2];
  const b = arr[arr.length - 1];
  const p0 = Number(a?.price);
  const p1 = Number(b?.price);
  if (!Number.isFinite(p0) || !Number.isFinite(p1) || p0 <= 0) return null;
  return Math.round((Math.abs(p1 - p0) / p0) * 10000);
}

async function main() {
  const store = loadStore();
  const metrics = store.metrics;
  const history = store.history;
  const now = new Date().toISOString();

  // Solend: compute utilization + TVL/liquidity (USDC reserve) from on-chain reserve state.
  let solend = null;
  try {
    solend = await fetchSolendUsdcReserveState({
      rpcUrl: process.env.SOLANA_RPC_URL,
      apiHost: process.env.SOLEND_API_HOST,
    });
  } catch (e) {
    solend = null;
  }

  // USDC: base units -> USD by dividing 1e6
  const toUsd = (base) => (base == null ? null : Number(base) / 1_000_000);

  upsertMetric(metrics, {
    chain: 'solana',
    protocol: 'solend',
    market: 'main',
    tvl_usd: solend?.tvl_base != null ? toUsd(solend.tvl_base) : null,
    liquidity_usd: solend?.available_base != null ? toUsd(solend.available_base) : null,
    price_vol_5m_bps: null,
    borrow_utilization_bps: solend?.utilization_bps ?? null,
    source_url: solend?.source_url || 'https://api.save.finance/v1/markets/configs?scope=all&deployment=production',
    updated_at: now,
  });

  async function fetchMeteoraDlmmPair(poolAddress) {
    const url = `https://dlmm-api.meteora.ag/pair/${poolAddress}`;
    const out = await fetchJson(url);
    const liquidity = out?.liquidity != null ? Number(out.liquidity) : null;
    return {
      poolAddress,
      name: out?.name,
      liquidity_usd: Number.isFinite(liquidity) ? liquidity : null,
      // API doesn't expose a dedicated "tvl" field; treat liquidity as TVL proxy for v0.
      tvl_usd: Number.isFinite(liquidity) ? liquidity : null,
      source_url: url,
    };
  }

  // Meteora DLMM: SOL/USDC — use SOL/USD 5m change as a volatility proxy for now.
  let solPrice = null;
  try {
    // Derive SOL/USD from Solend reserve's Pyth oracle (on-chain).
    solPrice = await fetchSolUsdPrice({ rpcUrl: solend?.rpcUrl, pythOracle: solend?.pyth_oracle });
    pushHistory(history, 'sol:usd', { ts: now, price: solPrice.price }, 24);
  } catch {
    solPrice = null;
  }

  const vol5mBps = computeVolBpsFromLastTwo(history, 'sol:usd');

  // Default to a high-liquidity SOL/USDC DLMM pool unless overridden.
  const meteoraPool = process.env.METEORA_DLMM_POOL || 'BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh';
  let meteora = null;
  try {
    meteora = await fetchMeteoraDlmmPair(meteoraPool);
  } catch {
    meteora = null;
  }

  upsertMetric(metrics, {
    chain: 'solana',
    protocol: 'meteora',
    market: 'dlmm:SOL/USDC',
    tvl_usd: meteora?.tvl_usd ?? null,
    liquidity_usd: meteora?.liquidity_usd ?? null,
    price_vol_5m_bps: vol5mBps,
    borrow_utilization_bps: null,
    source_url: meteora?.source_url || solPrice?.source_url || 'https://meteora.ag (DLMM)',
    updated_at: now,
  });

  saveStore({ metrics, history });

  console.log(JSON.stringify({ ok: true, store: STORE_PATH, updated: metrics.length }));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
  process.exit(1);
});
