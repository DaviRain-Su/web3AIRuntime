import crypto from "node:crypto";

export type QuoteFallbackResult =
  | { ok: true; mode: "jupiter"; quoteId: string; requestedSlippageBps?: number; quoteResponse: any }
  | { ok: false; mode: "fallback"; error: string; reason: string };

export function isLikelyJupiterAuthError(errMsg: string): boolean {
  const m = errMsg.toLowerCase();
  return m.includes("401") || m.includes("unauthorized") || m.includes("x-api-key");
}

export function isLikelyJupiterDownError(errMsg: string): boolean {
  const m = errMsg.toLowerCase();
  return m.includes("enotfound") || m.includes("fetch failed") || m.includes("timeout") || m.includes("rate limit");
}

export function makeQuoteId(): string {
  return "q_" + crypto.randomBytes(6).toString("hex");
}
