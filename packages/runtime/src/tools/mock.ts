import crypto from "node:crypto";
import type { Tool, Dict } from "./types.js";

/**
 * Mock tools for testing workflows without real chain interactions.
 * Used by mock-arb.yaml and similar test workflows.
 */
export function createMockTools(): Tool[] {
  return [
    {
      name: "price_check",
      meta: { action: "price_check", sideEffect: "none", risk: "low" },
      async execute(params) {
        const tokens = params.tokens ?? [];
        const chains = params.chains ?? [];
        return {
          tokens,
          chains,
          prices: {
            SUI: 1.2,
            USDC: 1.0,
            SOL: 150.0,
          },
        };
      },
    },
    {
      name: "calculate_opportunity",
      meta: { action: "calc_opportunity", sideEffect: "none", risk: "low" },
      async execute(params) {
        const minProfit = Number(params.minProfit ?? 0);
        return {
          ok: true,
          profit: Math.max(minProfit + 5, 15),
          sourceChain: "sui",
          targetChain: "bnb",
          sourceToken: "SUI",
          targetToken: "USDC",
          amount: "100",
        };
      },
    },
    {
      name: "simulate_swap",
      meta: { action: "swap", sideEffect: "none", risk: "low" },
      async execute(params) {
        return {
          ok: true,
          chain: params.chain,
          from: params.from,
          to: params.to,
          amount: params.amount,
          profitUsd: 60,
        };
      },
    },
    {
      name: "swap",
      meta: { action: "swap", sideEffect: "broadcast", chain: "sui", risk: "high" },
      async execute(params, ctx) {
        const profitUsd = Number(ctx?.simulation?.profitUsd ?? 0);
        return {
          ok: true,
          chain: params.chain,
          from: params.from,
          to: params.to,
          amount: params.amount,
          profitUsd,
          txHash: "mock_tx_" + crypto.randomBytes(4).toString("hex"),
        };
      },
    },
    {
      name: "verify_balance",
      meta: { action: "verify_balance", sideEffect: "none", risk: "low" },
      async execute() {
        return { ok: true };
      },
    },
    {
      name: "notify",
      meta: { action: "notify", sideEffect: "none", risk: "low" },
      async execute(params) {
        return { ok: true, message: params.message };
      },
    },
  ];
}
