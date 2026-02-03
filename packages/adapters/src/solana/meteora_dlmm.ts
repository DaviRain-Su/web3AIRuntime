import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import BN from "bn.js";
import dlmmPkg, { StrategyType } from "@meteora-ag/dlmm";

// ESM/CJS interop guard (NodeNext + mixed module exports)
const DLMM: any = (dlmmPkg as any)?.default ?? (dlmmPkg as any);

import type { Adapter, AdapterCapability, BuildTxResult } from "../types.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Pick a high-liquidity SOL/USDC DLMM pool as default.
// Source: https://dlmm-api.meteora.ag/pair/all (filtered SOL/USDC)
const DEFAULT_SOL_USDC_POOL = "BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh";

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
      const latest = await connection.getLatestBlockhash("confirmed");
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
      const latest = await connection.getLatestBlockhash("confirmed");
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
