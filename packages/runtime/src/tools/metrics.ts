import type { Tool, Dict } from "./types.js";

function baseUrl(): string {
  return process.env.W3RT_METRICS_URL || "";
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

export function createMetricsTools(): Tool[] {
  return [
    {
      name: "metrics_get",
      meta: {
        chain: "solana",
        action: "metrics.get",
        sideEffect: "none",
        risk: "low",
      },
      execute: async (params: Dict) => {
        const base = baseUrl();
        if (!base) return { ok: false, error: "MISSING_W3RT_METRICS_URL" };

        const chain = String(params.chain || "solana");
        const protocol = String(params.protocol || "");
        const market = String(params.market || "");
        if (!protocol || !market) return { ok: false, error: "MISSING_PARAMS" };

        const url = new URL("/v1/metrics/get", base);
        url.searchParams.set("chain", chain);
        url.searchParams.set("protocol", protocol);
        url.searchParams.set("market", market);
        const out = await fetchJson(url.toString());
        return out;
      },
    },
    {
      name: "metrics_list",
      meta: {
        chain: "solana",
        action: "metrics.list",
        sideEffect: "none",
        risk: "low",
      },
      execute: async (params: Dict) => {
        const base = baseUrl();
        if (!base) return { ok: false, error: "MISSING_W3RT_METRICS_URL" };

        const chain = String(params.chain || "solana");
        const limit = Number(params.limit ?? 20);

        const url = new URL("/v1/metrics/list", base);
        url.searchParams.set("chain", chain);
        url.searchParams.set("limit", String(limit));
        const out = await fetchJson(url.toString());
        return out;
      },
    },
  ];
}
