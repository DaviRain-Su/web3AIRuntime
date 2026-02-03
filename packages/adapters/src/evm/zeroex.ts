import type { Adapter, AdapterCapability, BuildTxResult } from "../types.js";

async function fetchJson(url: string, opts: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, { headers: opts.headers, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(t);
  }
}

export const zeroExAdapter: Adapter = {
  id: "zeroex",
  chain: "evm",

  capabilities(): AdapterCapability[] {
    return [
      {
        action: "evm.swap_exact_in",
        description: "0x swap exact-in (builds tx calldata via 0x Swap API)",
        risk: "high",
        paramsSchema: {
          type: "object",
          required: ["sellToken", "buyToken", "sellAmount"],
          properties: {
            chainId: { type: "number", description: "EVM chainId (e.g. 1 Ethereum, 8453 Base)" },
            sellToken: { type: "string", description: "Token address or symbol (ETH)" },
            buyToken: { type: "string", description: "Token address or symbol" },
            sellAmount: { type: "string", description: "Sell amount in base units" },
            slippageBps: { type: "number", description: "Max slippage bps" },
            takerAddress: { type: "string", description: "User address" },
          },
        },
      },
    ];
  },

  async buildTx(action, params, ctx): Promise<BuildTxResult> {
    if (action !== "evm.swap_exact_in") throw new Error(`Unsupported action: ${action}`);

    const base = process.env.W3RT_ZEROEX_BASE_URL || "https://api.0x.org";
    const apiKey = process.env.W3RT_ZEROEX_API_KEY;

    const chainId = params.chainId != null ? Number(params.chainId) : Number(process.env.W3RT_EVM_CHAIN_ID || 1);
    const sellToken = String(params.sellToken);
    const buyToken = String(params.buyToken);
    const sellAmount = String(params.sellAmount);
    const takerAddress = String(params.takerAddress || ctx?.userAddress || "");
    if (!takerAddress) throw new Error("Missing takerAddress (user address)");

    const slippageBps = params.slippageBps != null ? Number(params.slippageBps) : undefined;
    const slippagePct = typeof slippageBps === "number" ? Math.max(0, slippageBps) / 10_000 : undefined;

    // 0x Swap API v1 style (some deployments require chainId param; harmless if ignored)
    const url = new URL("/swap/v1/quote", base);
    url.searchParams.set("sellToken", sellToken);
    url.searchParams.set("buyToken", buyToken);
    url.searchParams.set("sellAmount", sellAmount);
    url.searchParams.set("takerAddress", takerAddress);
    url.searchParams.set("chainId", String(chainId));
    if (typeof slippagePct === "number") url.searchParams.set("slippagePercentage", String(slippagePct));

    const quote = await fetchJson(url.toString(), {
      headers: apiKey ? { "0x-api-key": apiKey } : undefined,
    });

    const to = quote?.to;
    const data = quote?.data;
    const value = quote?.value;
    if (!to || !data) throw new Error("0x quote missing tx fields (to/data)");

    return {
      ok: true,
      txB64: Buffer.from(
        JSON.stringify({
          chainId,
          from: takerAddress,
          to,
          data,
          value: value ?? "0x0",
          // Include allowanceTarget info for UX (approval planning) even if we don't execute approvals yet.
          allowanceTarget: quote?.allowanceTarget,
          buyAmount: quote?.buyAmount,
          sellAmount: quote?.sellAmount,
        })
      ).toString("base64"),
      meta: {
        chain: "evm",
        adapter: "zeroex",
        action,
        mints: { inputMint: sellToken, outputMint: buyToken },
        amounts: { inAmount: sellAmount, outAmount: String(quote?.buyAmount ?? "") },
        slippageBps,
        programHints: [String(to)],
      },
    };
  },
};
