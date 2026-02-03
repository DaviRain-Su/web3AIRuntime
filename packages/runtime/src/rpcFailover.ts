import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";

export type RpcFailoverState = {
  currentIndex: number;
  lastErrorAt?: number;
  lastError?: string;
};

function defaultW3rtDir() {
  return join(os.homedir(), ".w3rt");
}

function statePath(w3rtDir: string) {
  return join(w3rtDir, "rpc_state.json");
}

export function getSolanaRpcCandidates(): string[] {
  // Highest priority: explicit list
  const listRaw = process.env.W3RT_SOLANA_RPC_URLS;
  if (listRaw) {
    const xs = listRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (xs.length) return xs;
  }

  // Fallback to single URL
  const single = process.env.W3RT_SOLANA_RPC_URL;
  if (single) return [single];

  return [];
}

export function loadRpcFailoverState(w3rtDir?: string): RpcFailoverState {
  const dir = w3rtDir ?? defaultW3rtDir();
  try {
    const raw = readFileSync(statePath(dir), "utf-8");
    const j = JSON.parse(raw);
    const idx = Number(j?.currentIndex ?? 0);
    return {
      currentIndex: Number.isFinite(idx) && idx >= 0 ? idx : 0,
      lastErrorAt: Number.isFinite(j?.lastErrorAt) ? j.lastErrorAt : undefined,
      lastError: typeof j?.lastError === "string" ? j.lastError : undefined,
    };
  } catch {
    return { currentIndex: 0 };
  }
}

export function saveRpcFailoverState(w3rtDir: string, st: RpcFailoverState) {
  try {
    mkdirSync(dirname(statePath(w3rtDir)), { recursive: true });
    writeFileSync(statePath(w3rtDir), JSON.stringify(st, null, 2));
  } catch {
    // best-effort
  }
}

export function getActiveSolanaRpc(w3rtDir?: string): string {
  const candidates = getSolanaRpcCandidates();
  if (!candidates.length) return "";

  const dir = w3rtDir ?? defaultW3rtDir();
  const st = loadRpcFailoverState(dir);
  const idx = st.currentIndex % candidates.length;
  return candidates[idx];
}

export function rotateSolanaRpc(w3rtDir: string, reason?: string) {
  const candidates = getSolanaRpcCandidates();
  if (candidates.length <= 1) return;

  const st = loadRpcFailoverState(w3rtDir);
  const next = (st.currentIndex + 1) % candidates.length;
  saveRpcFailoverState(w3rtDir, {
    currentIndex: next,
    lastErrorAt: Date.now(),
    lastError: reason,
  });
}

export function isLikelyRpcError(err: any): boolean {
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  const code = String(err?.code ?? "").toLowerCase();

  // Common network / fetch / RPC failures
  if (code.includes("etimedout") || code.includes("econnreset") || code.includes("econnrefused")) return true;
  if (msg.includes("fetch failed")) return true;
  if (msg.includes("429") || msg.includes("rate limit")) return true;
  if (msg.includes("gateway") && msg.includes("timeout")) return true;
  if (msg.includes("enotfound")) return true;
  if (msg.includes("failed to fetch")) return true;
  if (msg.includes("network" ) && msg.includes("error")) return true;

  return false;
}
