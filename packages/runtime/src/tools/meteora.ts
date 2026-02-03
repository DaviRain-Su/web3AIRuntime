import type { Tool, Dict } from "./types.js";

const DLMM_API = "https://dlmm-api.meteora.ag";

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function normMint(m: string) {
  return String(m || "").trim();
}

export function createMeteoraTools(): Tool[] {
  return [
    {
      name: "meteora_pick_pool",
      meta: { chain: "solana", action: "meteora.pick_pool", sideEffect: "none", risk: "low" },
      async execute(params: Dict, ctx?: any) {
        const inputMint = normMint(params.inputMint);
        const outputMint = normMint(params.outputMint);
        if (!inputMint || !outputMint) return { ok: false, error: "MISSING_MINTS" };

        const allowedPairs = Array.isArray(ctx?.__profile?.allowedPairs) ? ctx.__profile.allowedPairs : null;
        const allowedPools = Array.isArray(ctx?.__profile?.allowedMeteoraPools) ? ctx.__profile.allowedMeteoraPools : null;

        // NOTE: The DLMM API doesn't currently provide a direct query-by-mints endpoint.
        // We fetch the catalog and pick the highest-liquidity verified pool matching the mints.
        const all = await fetchJson(`${DLMM_API}/pair/all`);
        const rows: any[] = Array.isArray(all) ? all : [];

        const candidates = rows.filter((p) => {
          if (!p?.address || !p?.mint_x || !p?.mint_y) return false;
          const mx = String(p.mint_x);
          const my = String(p.mint_y);
          const match =
            (mx === inputMint && my === outputMint) ||
            (mx === outputMint && my === inputMint);
          if (!match) return false;

          if (allowedPools && allowedPools.length && !allowedPools.includes(String(p.address))) return false;
          return true;
        });

        // pair allowlist (human-readable like SOL/USDC). Best-effort: enforce only when present.
        if (allowedPairs && allowedPairs.length) {
          const wanted = new Set(allowedPairs.map((s: any) => String(s).toUpperCase()));
          // Most DLMM API names look like "SOL-USDC".
          const filtered = candidates.filter((c) => {
            const n = String(c?.name || "").toUpperCase();
            return wanted.has(n.replace(/-/g, "/")) || wanted.has(n) || wanted.has(n.replace(/-/g, "-"));
          });
          // If allowlist is present and nothing matches, fail closed.
          if (!filtered.length) {
            return {
              ok: false,
              error: "PAIR_NOT_ALLOWED",
              message: `Pair not allowed by profile.allowedPairs`,
              inputMint,
              outputMint,
            };
          }
          candidates.splice(0, candidates.length, ...filtered);
        }

        if (!candidates.length) {
          return { ok: false, error: "NO_POOL_FOUND", inputMint, outputMint };
        }

        // Prefer verified + highest liquidity
        const scored = candidates
          .map((c) => {
            const liq = c?.liquidity != null ? Number(c.liquidity) : NaN;
            return {
              ...c,
              __liq: Number.isFinite(liq) ? liq : 0,
              __verified: c?.is_verified === true,
            };
          })
          .sort((a, b) => {
            if (a.__verified !== b.__verified) return a.__verified ? -1 : 1;
            return b.__liq - a.__liq;
          });

        const best = scored[0];

        return {
          ok: true,
          poolAddress: String(best.address),
          name: best.name,
          liquidity_usd: best.__liq,
          verified: best.__verified,
          mint_x: best.mint_x,
          mint_y: best.mint_y,
          source_url: `${DLMM_API}/pair/${best.address}`,
        };
      },
    },
  ];
}
