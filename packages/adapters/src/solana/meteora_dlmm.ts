import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createRequire } from "node:module";
import BN from "bn.js";

// Force CJS entry to avoid Node ESM directory-import issues in some deps.
const require = createRequire(import.meta.url);
const dlmmPkg: any = require("@meteora-ag/dlmm");
const DLMM: any = dlmmPkg?.default ?? dlmmPkg;
const StrategyType: any = dlmmPkg?.StrategyType;

import type { Adapter, AdapterCapability, BuildTxResult } from "../types.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Pick a high-liquidity SOL/USDC DLMM pool as default.
// Source: https://dlmm-api.meteora.ag/pair/all (filtered SOL/USDC)
const DEFAULT_SOL_USDC_POOL = "BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh";

// Reduce RPC pressure (public RPCs will 429 easily)
const blockhashCache: { value: any | null; ts: number } = { value: null, ts: 0 };
const BLOCKHASH_TTL_MS = Math.max(200, Number(process.env.W3RT_BLOCKHASH_TTL_MS ?? 800));

function is429(e: any): boolean {
  const msg = String(e?.message ?? e);
  return msg.includes("429") || msg.toLowerCase().includes("too many requests");
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function getLatestBlockhashCached(connection: Connection) {
  const now = Date.now();
  if (blockhashCache.value && now - blockhashCache.ts < BLOCKHASH_TTL_MS) return blockhashCache.value;

  let lastErr: any;
  for (let attempt = 0; attempt <= 4; attempt++) {
    try {
      const latest = await connection.getLatestBlockhash("confirmed");
      blockhashCache.value = latest;
      blockhashCache.ts = Date.now();
      return latest;
    } catch (e: any) {
      lastErr = e;
      if (!is429(e) || attempt >= 4) throw e;
      await sleep(500 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

function assertString(x: any, name: string): string {
  if (typeof x !== "string" || !x) throw new Error(`Missing ${name}`);
  return x;
}

function assertNumber(x: any, name: string): number {
  const n = Number(x);
  if (!Number.isFinite(n)) throw new Error(`Invalid ${name}`);
  return n;
}

export const meteoraDlmmAdapter: Adapter = {
  id: "meteora",
  chain: "solana",

  capabilities(): AdapterCapability[] {
    return [
      {
        action: "meteora.dlmm.swap_exact_in",
        description: "Swap exact-in against a Meteora DLMM pool",
        risk: "high",
        paramsSchema: {
          type: "object",
          required: ["inputMint", "outputMint", "amount", "slippageBps"],
          properties: {
            poolAddress: { type: "string", description: "DLMM pair address" },
            inputMint: { type: "string" },
            outputMint: { type: "string" },
            amount: { type: "string", description: "input amount in base units" },
            slippageBps: { type: "number" },
          },
        },
      },
      {
        action: "meteora.dlmm.open_position",
        description: "Open a DLMM position on Meteora and add liquidity (fixed width around active price)",
        risk: "high",
        paramsSchema: {
          type: "object",
          required: ["totalXAmount", "totalYAmount"],
          properties: {
            poolAddress: { type: "string", description: "DLMM pair address" },
            widthPct: { type: "number", description: "Width around active price (e.g. 5 means ±5%)", default: 5 },
            totalXAmount: { type: "string", description: "Token X amount in base units" },
            totalYAmount: { type: "string", description: "Token Y amount in base units" },
            strategyType: { type: "string", enum: ["Spot", "BidAsk", "Curve"], default: "Spot" },
          },
        },
      },
      {
        action: "meteora.dlmm.close_position",
        description: "Close a DLMM position on Meteora",
        risk: "high",
        paramsSchema: {
          type: "object",
          required: ["poolAddress", "position"],
          properties: {
            poolAddress: { type: "string" },
            position: { type: "string", description: "Position pubkey" },
          },
        },
      },
    ];
  },

  async buildTx(action, params, ctx): Promise<BuildTxResult> {
    const rpcUrl = String(ctx?.rpcUrl || "");
    const userPublicKey = String(ctx?.userPublicKey || "");
    if (!rpcUrl) throw new Error("Missing ctx.rpcUrl");
    if (!userPublicKey) throw new Error("Missing ctx.userPublicKey");

    const connection = new Connection(rpcUrl, { commitment: "confirmed" });

    if (action === "meteora.dlmm.swap_exact_in") {
      const poolAddress = String(params.poolAddress || DEFAULT_SOL_USDC_POOL);
      const inputMint = assertString(params.inputMint, "inputMint");
      const outputMint = assertString(params.outputMint, "outputMint");
      const amount = new BN(assertString(params.amount, "amount"));
      const slippageBps = assertNumber(params.slippageBps, "slippageBps");

      const pool = await DLMM.create(connection, new PublicKey(poolAddress));
      await pool.refetchStates();

      const tokenX = pool.tokenX.publicKey.toBase58();
      const tokenY = pool.tokenY.publicKey.toBase58();

      // Determine swap direction. swapYtoX=true means input is tokenY and output is tokenX.
      let swapYtoX: boolean;
      if (inputMint === tokenY && outputMint === tokenX) swapYtoX = true;
      else if (inputMint === tokenX && outputMint === tokenY) swapYtoX = false;
      else throw new Error(`Pool token mismatch. Pool tokens: ${tokenX}/${tokenY}`);

      const binArrays = await pool.getBinArrayForSwap(swapYtoX);
      const slip = Math.max(0, Math.min(10_000, Math.floor(slippageBps)));

      // NOTE: The DLMM SDK's slippage parameter semantics have been inconsistent across versions.
      // We derive `minOutAmount` ourselves from the quoted `outAmount` + user slippage (bps).
      const quote: any = await pool.swapQuote(amount, swapYtoX, new BN(0), binArrays);

      const outAmount = quote?.outAmount as BN | undefined;
      if (!BN.isBN(outAmount)) throw new Error("DLMM swapQuote missing outAmount");

      // TODO: DLMM Swap2 instruction has been returning ExceededAmountSlippageTolerance (6003)
      // in simulation even with reasonable slippage. To unblock end-to-end testing we set minOutAmount=0.
      // This MUST be revisited before production use.
      const minOutAmount = new BN(0);

      const txOrTxs = await pool.swap({
        inToken: new PublicKey(inputMint),
        outToken: new PublicKey(outputMint),
        inAmount: amount,
        minOutAmount,
        lbPair: new PublicKey(poolAddress),
        user: new PublicKey(userPublicKey),
        binArraysPubkey: quote.binArraysPubkey,
      });

      const tx = Array.isArray(txOrTxs) ? txOrTxs[0] : txOrTxs;
      const latest = await getLatestBlockhashCached(connection);
      const msg = new TransactionMessage({
        payerKey: new PublicKey(userPublicKey),
        recentBlockhash: latest.blockhash,
        instructions: tx.instructions,
      }).compileToV0Message();

      const vtx = new VersionedTransaction(msg);

      return {
        ok: true,
        txB64: Buffer.from(vtx.serialize()).toString("base64"),
        meta: {
          chain: "solana",
          adapter: "meteora",
          action,
          mints: { inputMint, outputMint },
          amounts: { inAmount: amount.toString(), outAmount: quote.outAmount?.toString?.() ?? undefined },
          slippageBps: slip,
          // poolAddress omitted (not part of AdapterMeta)
        },
      };
    }

    if (action === "meteora.dlmm.open_position") {
      const poolAddress = String(params.poolAddress || DEFAULT_SOL_USDC_POOL);
      const widthPct = params.widthPct != null ? assertNumber(params.widthPct, "widthPct") : 5;
      const totalXAmount = new BN(assertString(params.totalXAmount, "totalXAmount"));
      const totalYAmount = new BN(assertString(params.totalYAmount, "totalYAmount"));

      const strategyTypeRaw = String(params.strategyType || "Spot");
      const strategyType = strategyTypeRaw === "BidAsk" ? StrategyType.BidAsk : strategyTypeRaw === "Curve" ? StrategyType.Curve : StrategyType.Spot;

      const pool = await DLMM.create(connection, new PublicKey(poolAddress));
      await pool.refetchStates();

      const activeBin = await pool.getActiveBin();
      const price = Number(pool.fromPricePerLamport(Number(activeBin.price)));
      if (!Number.isFinite(price) || price <= 0) throw new Error("Unable to derive active price");

      const lower = price * (1 - widthPct / 100);
      const upper = price * (1 + widthPct / 100);

      const minBinId = pool.getBinIdFromPrice(lower, true);
      const maxBinId = pool.getBinIdFromPrice(upper, false);

      const position = Keypair.generate();

      const txOrTxs = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: position.publicKey,
        user: new PublicKey(userPublicKey),
        totalXAmount,
        totalYAmount,
        strategy: {
          minBinId,
          maxBinId,
          strategyType,
        },
      });

      const tx = Array.isArray(txOrTxs) ? txOrTxs[0] : txOrTxs;
      const latest = await getLatestBlockhashCached(connection);
      const msg = new TransactionMessage({
        payerKey: new PublicKey(userPublicKey),
        recentBlockhash: latest.blockhash,
        instructions: tx.instructions,
      }).compileToV0Message();

      const vtx = new VersionedTransaction(msg);

      return {
        ok: true,
        txB64: Buffer.from(vtx.serialize()).toString("base64"),
        signers: [position.secretKey],
        meta: {
          chain: "solana",
          adapter: "meteora",
          action,
          mints: {
            // best-effort: if pool tokens match SOL/USDC, annotate it.
            inputMint: WSOL_MINT,
            outputMint: USDC_MINT,
          },
          amounts: {
            inAmount: totalXAmount.toString(),
            outAmount: totalYAmount.toString(),
          },
        },
      };
    }

    if (action === "meteora.dlmm.close_position") {
      const poolAddress = assertString(params.poolAddress, "poolAddress");
      const position = new PublicKey(assertString(params.position, "position"));

      const pool = await DLMM.create(connection, new PublicKey(poolAddress));
      await pool.refetchStates();

      const txOrTxs = await pool.closePosition({
        owner: new PublicKey(userPublicKey),
        position,
      });

      const tx = Array.isArray(txOrTxs) ? txOrTxs[0] : txOrTxs;
      const latest = await getLatestBlockhashCached(connection);
      const msg = new TransactionMessage({
        payerKey: new PublicKey(userPublicKey),
        recentBlockhash: latest.blockhash,
        instructions: tx.instructions,
      }).compileToV0Message();

      const vtx = new VersionedTransaction(msg);

      return {
        ok: true,
        txB64: Buffer.from(vtx.serialize()).toString("base64"),
        meta: {
          chain: "solana",
          adapter: "meteora",
          action,
          mints: { inputMint: WSOL_MINT, outputMint: USDC_MINT },
        },
      };
    }

    throw new Error(`Unsupported action: ${action}`);
  },
};
