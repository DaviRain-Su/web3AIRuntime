import type { ChainDriver, ExtractIdsResult, SimResult } from "./types.js";

export class EvmDriver implements ChainDriver {
  chain = "evm" as const;

  async simulateTxB64(_txB64: string, _ctx: { rpcUrl: string }): Promise<SimResult> {
    return { ok: false, err: "UNSUPPORTED" };
  }

  async extractIdsFromTxB64(_txB64: string, _ctx: { rpcUrl: string }): Promise<ExtractIdsResult> {
    return { known: false, ids: [] };
  }
}
