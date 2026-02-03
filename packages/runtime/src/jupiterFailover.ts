import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";

export type JupiterFailoverState = {
  currentIndex: number;
  lastErrorAt?: number;
  lastError?: string;
};

function defaultW3rtDir() {
  return join(os.homedir(), ".w3rt");
}

function statePath(w3rtDir: string) {
  return join(w3rtDir, "jupiter_state.json");
}

export function getJupiterBaseCandidates(): string[] {
  const listRaw = process.env.W3RT_JUPITER_BASE_URLS;
  if (listRaw) {
    const xs = listRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (xs.length) return xs;
  }

  const single = process.env.W3RT_JUPITER_BASE_URL;
  if (single) return [single];

  return ["https://api.jup.ag"]; // default
}

export function loadJupiterFailoverState(w3rtDir?: string): JupiterFailoverState {
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

export function saveJupiterFailoverState(w3rtDir: string, st: JupiterFailoverState) {
  try {
    mkdirSync(dirname(statePath(w3rtDir)), { recursive: true });
    writeFileSync(statePath(w3rtDir), JSON.stringify(st, null, 2));
  } catch {
    // best-effort
  }
}

export function getActiveJupiterBaseUrl(w3rtDir?: string): string {
  const candidates = getJupiterBaseCandidates();
  if (!candidates.length) return "https://api.jup.ag";
  const dir = w3rtDir ?? defaultW3rtDir();
  const st = loadJupiterFailoverState(dir);
  const idx = st.currentIndex % candidates.length;
  return candidates[idx];
}

export function rotateJupiterBaseUrl(w3rtDir: string, reason?: string) {
  const candidates = getJupiterBaseCandidates();
  if (candidates.length <= 1) return;
  const st = loadJupiterFailoverState(w3rtDir);
  const next = (st.currentIndex + 1) % candidates.length;
  saveJupiterFailoverState(w3rtDir, {
    currentIndex: next,
    lastErrorAt: Date.now(),
    lastError: reason,
  });
}

export function isLikelyJupiterNetworkError(err: any): boolean {
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  const code = String(err?.code ?? "").toLowerCase();
  if (code.includes("etimedout") || code.includes("econnreset") || code.includes("econnrefused")) return true;
  if (msg.includes("enotfound") || msg.includes("fetch failed") || msg.includes("timeout")) return true;
  if (msg.includes("429") || msg.includes("rate limit")) return true;
  return false;
}
