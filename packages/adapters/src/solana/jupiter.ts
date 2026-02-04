import type { Adapter, AdapterCapability, BuildTxResult } from "../types.js";

type QuoteResponse = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
};

async function fetchJsonWithRetry(url: string, opts: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  timeoutMs?: number;
  retries?: number;
}): Promise<any> {
  const { method = "GET", headers, body, timeoutMs = 15_000, retries = 2 } = opts;

  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
      return text ? JSON.parse(text) : null;
    } catch (e) {
      lastErr = e;
      if (attempt >= retries) break;
      await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr;
}

export const jupiterAdapter: Adapter = {
  id: "jupiter",
  chain: "solana",

  capabilities(): AdapterCapability[] {
    return [
      {
        action: "solana.swap_exact_in",
        description: "Jupiter swap exact-in (builds a versioned tx via /swap/v1/swap)",
        risk: "high",
        paramsSchema: {
          type: "object",
          required: ["inputMint", "outputMint", "amount", "slippageBps"],
          properties: {
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
    if (action !== "solana.swap_exact_in") throw new Error(`Unsupported action: ${action}`);

    const base = process.env.W3RT_JUPITER_BASE_URL || "https://api.jup.ag";
    const apiKey = process.env.W3RT_JUPITER_API_KEY;

    const userPublicKey = String(ctx?.userPublicKey || "");
    if (!userPublicKey) throw new Error("Missing ctx.userPublicKey (Solana keypair not configured)");

    const inputMint = String(params.inputMint);
    const outputMint = String(params.outputMint);
    const amount = String(params.amount);
    const slippageBps = Number(params.slippageBps);

    async function buildVia(baseUrl: string, key?: string) {
      // 1) quote
      const quoteUrl = new URL("/swap/v1/quote", baseUrl);
      quoteUrl.searchParams.set("inputMint", inputMint);
      quoteUrl.searchParams.set("outputMint", outputMint);
      quoteUrl.searchParams.set("amount", amount);
      quoteUrl.searchParams.set("slippageBps", String(slippageBps));

      const quote = (await fetchJsonWithRetry(quoteUrl.toString(), {
        headers: key ? { "x-api-key": key } : undefined,
      })) as QuoteResponse;

      // 2) build tx
      const swapBody = {
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true,
      };

      const swapOut = await fetchJsonWithRetry(new URL("/swap/v1/swap", baseUrl).toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { "x-api-key": key } : {}),
        },
        body: swapBody,
      });

      return { quote, swapOut };
    }

    let quote: QuoteResponse;
    let swapOut: any;

    try {
      ({ quote, swapOut } = await buildVia(base, apiKey));
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // If the configured base URL is a paid endpoint requiring auth, fall back to public Jupiter.
      if (msg.includes("HTTP 401") || msg.toLowerCase().includes("unauthorized")) {
        ({ quote, swapOut } = await buildVia("https://api.jup.ag", undefined));
      } else {
        throw e;
      }
    }

    const txB64 = swapOut?.swapTransaction;
    if (!txB64) throw new Error("Jupiter swap build response missing swapTransaction");

    return {
      ok: true,
      txB64,
      meta: {
        chain: "solana",
        adapter: "jupiter",
        action,
        mints: { inputMint, outputMint },
        amounts: { inAmount: quote?.inAmount, outAmount: quote?.outAmount },
        slippageBps,
      },
    };
  },
};
