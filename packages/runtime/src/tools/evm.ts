import type { Tool, Dict } from "./types.js";
import { createEthereumAdapter } from "@w3rt/chains";
import { defaultRegistry } from "@w3rt/adapters";

function rpcUrl(): string {
  return process.env.W3RT_EVM_RPC_URL || "https://eth.llamarpc.com";
}

function defaultChainId(): number {
  const n = Number(process.env.W3RT_EVM_CHAIN_ID || 1);
  return Number.isFinite(n) ? n : 1;
}

function getUserAddress(ctx: any): string {
  return String(ctx?.__evmUserAddress || process.env.W3RT_EVM_USER_ADDRESS || "");
}

function pairAllowed(profile: any, sellToken: string, buyToken: string): boolean {
  const allowed = Array.isArray(profile?.allowedPairsEvm)
    ? profile.allowedPairsEvm
    : null;
  if (!allowed || !allowed.length) return true;

  const s = String(sellToken).toLowerCase();
  const b = String(buyToken).toLowerCase();

  const ok = (p: string) => {
    const parts = String(p).split("/");
    if (parts.length !== 2) return false;
    const a0 = parts[0].trim().toLowerCase();
    const a1 = parts[1].trim().toLowerCase();
    return (a0 === s && a1 === b) || (a0 === b && a1 === s);
  };

  return allowed.some(ok);
}

export function createEvmTools(): Tool[] {
  return [
    {
      name: "evm_swap_exact_in",
      meta: { chain: "evm", action: "swap", sideEffect: "none", risk: "high" },
      async execute(params: Dict, ctx: Dict) {
        const profile = (ctx as any)?.__profile;

        const allowedProtocols: string[] = Array.isArray(profile?.allowedProtocols) ? profile.allowedProtocols : [];
        const allowZeroEx = allowedProtocols.length ? allowedProtocols.includes("zeroex") || allowedProtocols.includes("0x") : true;
        if (!allowZeroEx) throw new Error("0x (zeroex) is not allowed by profile.allowedProtocols");

        const chainId = params.chainId != null ? Number(params.chainId) : defaultChainId();
        const sellToken = String(params.sellToken);
        const buyToken = String(params.buyToken);
        const sellAmount = String(params.sellAmount);
        const slippageBps = params.slippageBps != null ? Number(params.slippageBps) : Number(profile?.maxSlippageBps ?? 100);

        if (!pairAllowed(profile, sellToken, buyToken)) {
          throw new Error("Pair not allowed by profile.allowedPairsEvm");
        }

        const userAddress = String(params.takerAddress || getUserAddress(ctx));
        if (!userAddress) throw new Error("Missing EVM user address (set W3RT_EVM_USER_ADDRESS or params.takerAddress)");

        const out = await defaultRegistry.get("zeroex").buildTx(
          "evm.swap_exact_in",
          {
            chainId,
            sellToken,
            buyToken,
            sellAmount,
            slippageBps,
            takerAddress: userAddress,
          },
          { userAddress }
        );

        // Populate ctx.quote (best-effort) so policy/slippage logic can reuse.
        (ctx as any).quote = {
          ok: true,
          quoteId: `0x_${Date.now()}`,
          requestedSlippageBps: slippageBps,
          quoteResponse: {
            inputMint: out.meta.mints?.inputMint,
            outputMint: out.meta.mints?.outputMint,
            inAmount: out.meta.amounts?.inAmount,
            outAmount: out.meta.amounts?.outAmount,
          },
        };

        return { ok: true, venue: "zeroex", txB64: out.txB64, meta: out.meta };
      },
    },
    {
      name: "evm_simulate_tx",
      meta: { chain: "evm", action: "simulate", sideEffect: "none", risk: "low" },
      async execute(params: Dict) {
        const tx = JSON.parse(Buffer.from(String(params.txB64), "base64").toString("utf-8"));
        const evm = createEthereumAdapter(rpcUrl());
        const sim = await evm.simulateTx({
          chain: "evm",
          txBytesB64: Buffer.from(JSON.stringify(tx)).toString("base64"),
          summary: {} as any,
        });
        return sim;
      },
    },
  ];
}
