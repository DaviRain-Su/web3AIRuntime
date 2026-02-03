import { Connection, PublicKey } from '@solana/web3.js';
import * as solend from '@solendprotocol/solend-sdk';

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

export async function fetchSolendUsdcUtilizationBps(opts = {}) {
  const rpcUrl = opts.rpcUrl || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const apiHost = opts.apiHost || 'https://api.save.finance';

  const markets = await fetchJson(`${apiHost}/v1/markets/configs?scope=all&deployment=production`);
  const market = (Array.isArray(markets) ? markets : []).find((m) => m?.name === 'main') || markets?.[0];
  if (!market) throw new Error('MARKET_NOT_FOUND');

  const reserveCfg = (market.reserves || []).find((r) => r?.liquidityToken?.symbol === 'USDC');
  if (!reserveCfg) throw new Error('USDC_RESERVE_NOT_FOUND');

  const reservePk = new PublicKey(reserveCfg.address);
  const conn = new Connection(rpcUrl, 'confirmed');
  const acc = await conn.getAccountInfo(reservePk);
  if (!acc?.data) throw new Error('RESERVE_ACCOUNT_NOT_FOUND');

  // ReserveLayout is exported by solend sdk.
  const layout = solend.ReserveLayout;
  if (!layout?.decode) throw new Error('ReserveLayout_NOT_FOUND');
  const decoded = layout.decode(acc.data);

  const toBigInt = (x) => {
    if (typeof x === 'bigint') return x;
    if (typeof x === 'number') return BigInt(x);
    if (x && typeof x.toString === 'function') {
      const s = x.toString();
      if (/^\d+$/.test(s)) return BigInt(s);
    }
    return 0n;
  };

  // ReserveLayout decode returns flattened keys (liquidityAvailableAmount / liquidityBorrowedAmountWads)
  const avail = toBigInt(decoded?.liquidityAvailableAmount);
  const borrowedWads = decoded?.liquidityBorrowedAmountWads;
  const borrowed = toBigInt(borrowedWads);
  const borrowedBase = borrowed / 1000000000000000000n;

  const denom = avail + borrowedBase;
  if (denom === 0n) return { utilization_bps: null, reserve: reserveCfg.address };
  const utilBps = Number((borrowedBase * 10000n) / denom);

  return {
    utilization_bps: utilBps,
    reserve: reserveCfg.address,
    available: avail.toString(),
    borrowed: borrowedBase.toString(),
    rpcUrl,
    source_url: `${apiHost}/v1/markets/configs?scope=all&deployment=production`,
  };
}
