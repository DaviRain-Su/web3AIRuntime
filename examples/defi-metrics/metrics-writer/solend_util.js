import { Connection, PublicKey } from '@solana/web3.js';
import * as solend from '@solendprotocol/solend-sdk';

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function toBigInt(x) {
  if (typeof x === 'bigint') return x;
  if (typeof x === 'number') return BigInt(x);
  if (x && typeof x.toString === 'function') {
    const s = x.toString();
    if (/^\d+$/.test(s)) return BigInt(s);
  }
  return 0n;
}

export async function fetchSolendUsdcReserveState(opts = {}) {
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

  const layout = solend.ReserveLayout;
  if (!layout?.decode) throw new Error('ReserveLayout_NOT_FOUND');
  const decoded = layout.decode(acc.data);

  // flattened fields
  const available = toBigInt(decoded?.liquidityAvailableAmount); // base units (USDC 6 decimals)
  const borrowedWads = toBigInt(decoded?.liquidityBorrowedAmountWads); // WAD (1e18)
  const borrowedBase = borrowedWads / 1000000000000000000n;

  // utilization = borrowed / (borrowed + available)
  const denom = available + borrowedBase;
  const utilization_bps = denom === 0n ? null : Number((borrowedBase * 10000n) / denom);

  // For USDC reserve, treat (available + borrowed) as TVL in base units.
  const tvl_base = available + borrowedBase;

  return {
    rpcUrl,
    source_url: `${apiHost}/v1/markets/configs?scope=all&deployment=production`,
    reserve: reserveCfg.address,
    available_base: available,
    borrowed_base: borrowedBase,
    tvl_base,
    utilization_bps,
    decimals: 6,
    // Useful for deriving SOL/USD via the same oracle stack used by the reserve.
    pyth_oracle: decoded?.liquidityPythOracle?.toBase58?.() ?? null,
  };
}
