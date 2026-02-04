import type { Adapter, AdapterCapability, BuildTxResult } from "../types.js";

import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import BN from "bn.js";

import {
  Raydium,
  TxVersion,
  PoolUtils,
  PoolFetchType,
  type ApiV3PoolInfoConcentratedItem,
  type ClmmKeys,
  type ComputeClmmPoolInfo,
  type ReturnTypeFetchMultiplePoolTickArrays,
} from "@raydium-io/raydium-sdk-v2";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function assertString(x: any, name: string): string {
  if (typeof x !== "string" || !x) throw new Error(`Missing ${name}`);
  return x;
}

function assertNumber(x: any, name: string): number {
  const n = Number(x);
  if (!Number.isFinite(n)) throw new Error(`Invalid ${name}`);
  return n;
}

function isValidClmm(programId: string): boolean {
  // Best-effort: accept any pubkey-like string.
  return typeof programId === "string" && programId.length >= 32;
}

async function initRaydium(connection: Connection, owner: PublicKey, cluster: "mainnet" | "devnet") {
  return await Raydium.load({
    connection,
    owner,
    cluster,
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: "confirmed",
  } as any);
}

async function loadClmmPool(params: {
  raydium: any;
  poolId?: string;
  inputMint: string;
  outputMint: string;
}): Promise<{
  poolId: string;
  poolInfo: ApiV3PoolInfoConcentratedItem;
  poolKeys?: ClmmKeys;
  clmmPoolInfo: ComputeClmmPoolInfo;
  tickCache: ReturnTypeFetchMultiplePoolTickArrays;
}> {
  const { raydium, poolId, inputMint, outputMint } = params;

  let poolInfo: ApiV3PoolInfoConcentratedItem;
  let poolKeys: ClmmKeys | undefined;
  let clmmPoolInfo: ComputeClmmPoolInfo;
  let tickCache: ReturnTypeFetchMultiplePoolTickArrays;

  if (raydium.cluster === "mainnet") {
    let id = poolId;
    if (!id) {
      const list = await raydium.api.fetchPoolByMints({
        mint1: inputMint,
        mint2: outputMint,
        type: PoolFetchType.All,
        sort: "liquidity",
        order: "desc",
        page: 1,
      });
      const arr: any[] = Array.isArray(list) ? list : (list?.data ?? []);
      const found = arr.find((p) => p && isValidClmm(p.programId));
      if (!found) throw new Error("No Raydium pool found for mints");
      id = String(found.id);
    }

    const data = await raydium.api.fetchPoolById({ ids: id });
    poolInfo = data[0] as ApiV3PoolInfoConcentratedItem;
    if (!poolInfo) throw new Error("Raydium API returned no pool info");
    if (!isValidClmm(poolInfo.programId)) throw new Error("Target pool is not CLMM");

    clmmPoolInfo = await PoolUtils.fetchComputeClmmInfo({ connection: raydium.connection, poolInfo });
    tickCache = await PoolUtils.fetchMultiplePoolTickArrays({ connection: raydium.connection, poolKeys: [clmmPoolInfo] });

    return { poolId: id, poolInfo, poolKeys: undefined, clmmPoolInfo, tickCache };
  }

  // devnet: rpc only
  if (!poolId) throw new Error("poolId required on devnet");
  const data = await raydium.clmm.getPoolInfoFromRpc(poolId);
  poolInfo = data.poolInfo;
  poolKeys = data.poolKeys;
  clmmPoolInfo = data.computePoolInfo;
  tickCache = data.tickData;

  return { poolId, poolInfo, poolKeys, clmmPoolInfo, tickCache };
}

export const raydiumClmmAdapter: Adapter = {
  id: "raydium",
  chain: "solana",

  capabilities(): AdapterCapability[] {
    return [
      {
        action: "raydium.clmm.swap_exact_in",
        description: "Raydium CLMM swap exact-in (builds a versioned tx via Raydium SDK)",
        risk: "high",
        paramsSchema: {
          type: "object",
          required: ["inputMint", "outputMint", "amount", "slippageBps"],
          properties: {
            poolId: { type: "string", description: "Optional CLMM pool id" },
            inputMint: { type: "string" },
            outputMint: { type: "string" },
            amount: { type: "string", description: "input amount in base units" },
            slippageBps: { type: "number" },
          },
        },
      },
    ];
  },

  async buildTx(action, params, ctx): Promise<BuildTxResult> {
    if (action !== "raydium.clmm.swap_exact_in") throw new Error(`Unsupported action: ${action}`);

    const rpcUrl = String(ctx?.rpcUrl || "");
    const userPublicKey = String(ctx?.userPublicKey || "");
    if (!rpcUrl) throw new Error("Missing ctx.rpcUrl");
    if (!userPublicKey) throw new Error("Missing ctx.userPublicKey");

    const poolId = params.poolId ? String(params.poolId) : undefined;
    const inputMint = assertString(params.inputMint, "inputMint");
    const outputMint = assertString(params.outputMint, "outputMint");
    const amount = new BN(assertString(params.amount, "amount"));
    const slippageBps = assertNumber(params.slippageBps, "slippageBps");

    const connection = new Connection(rpcUrl, { commitment: "confirmed" });
    const owner = new PublicKey(userPublicKey);
    const cluster: "mainnet" | "devnet" = rpcUrl.includes("devnet") ? "devnet" : "mainnet";

    const raydium = await initRaydium(connection, owner, cluster);

    const { poolInfo, poolKeys, clmmPoolInfo, tickCache, poolId: resolvedPoolId } = await loadClmmPool({
      raydium,
      poolId,
      inputMint,
      outputMint,
    });

    const baseIn = inputMint === poolInfo.mintA.address;

    const { minAmountOut, remainingAccounts } = await PoolUtils.computeAmountOutFormat({
      poolInfo: clmmPoolInfo,
      tickArrayCache: tickCache[resolvedPoolId],
      amountIn: amount,
      tokenOut: poolInfo[baseIn ? "mintB" : "mintA"],
      slippage: Math.max(0, Math.min(10_000, Math.floor(slippageBps))) / 10_000,
      epochInfo: await raydium.fetchEpochInfo(),
    } as any);

    const { transaction, builder }: any = await raydium.clmm.swap({
      poolInfo,
      poolKeys,
      inputMint: poolInfo[baseIn ? "mintA" : "mintB"].address,
      amountIn: amount,
      amountOutMin: minAmountOut.amount.raw,
      observationId: clmmPoolInfo.observationId,
      ownerInfo: {
        useSOLBalance: inputMint === WSOL_MINT,
      },
      remainingAccounts,
      txVersion: TxVersion.V0,
    });

    // Force a recent blockhash
    const latest = await connection.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({
      payerKey: owner,
      recentBlockhash: latest.blockhash,
      instructions: builder.allInstructions,
    }).compileToV0Message();

    const vtx = new VersionedTransaction(msg);

    return {
      ok: true,
      txB64: Buffer.from(vtx.serialize()).toString("base64"),
      meta: {
        chain: "solana",
        adapter: "raydium",
        action,
        mints: { inputMint, outputMint },
        amounts: { inAmount: amount.toString(), minOutAmount: String(minAmountOut?.amount?.raw ?? "") },
        slippageBps,
        poolId: resolvedPoolId,
        programId: poolInfo.programId,
      } as any,
    };
  },
};

export const RAYDIUM_PRESETS = {
  SOL_USDC: { inputMint: WSOL_MINT, outputMint: USDC_MINT },
};
