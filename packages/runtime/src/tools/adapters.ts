import type { Tool } from "./types.js";
import { defaultRegistry } from "@w3rt/adapters";

export type AdapterToolConfig = {
  getSolanaUserPublicKey?: () => string | null;
  getSolanaRpcUrl?: () => string;
  getEvmUserAddress?: () => string | null;
};

export function createAdapterTools(cfg: AdapterToolConfig = {}): Tool[] {
  const tools: Tool[] = [];

  for (const adapter of defaultRegistry.list()) {
    const adapterId = adapter.id;
    const chain = adapter.chain;

    for (const cap of adapter.capabilities()) {
      const toolName = `adapter.${adapterId}.${cap.action}`;

      tools.push({
        name: toolName,
        meta: {
          chain,
          action: cap.action,
          sideEffect: "none",
          risk: cap.risk,
        },
        execute: async (params: any, ctx: any) => {
          // Best-effort context injection so adapters can build tx without extra glue.
          const injectedCtx: any = { ...(ctx || {}) };

          if (chain === "solana") {
            injectedCtx.userPublicKey = injectedCtx.userPublicKey || cfg.getSolanaUserPublicKey?.() || undefined;
            injectedCtx.rpcUrl = injectedCtx.rpcUrl || cfg.getSolanaRpcUrl?.() || undefined;
          }

          if (chain === "evm") {
            injectedCtx.userAddress = injectedCtx.userAddress || cfg.getEvmUserAddress?.() || undefined;
          }

          return adapter.buildTx(cap.action, params, injectedCtx);
        },
      });
    }
  }

  return tools;
}
