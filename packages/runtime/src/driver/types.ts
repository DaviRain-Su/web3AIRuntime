export type ChainId = "solana" | "evm";

export type SimResult = {
  ok: boolean;
  err?: any;
  logs?: string[];
  unitsConsumed?: number | null;
};

export type ExtractIdsResult = {
  known: boolean;
  ids: string[];
};

export interface ChainDriver {
  chain: ChainId;

  simulateTxB64(txB64: string, ctx: { rpcUrl: string }): Promise<SimResult>;

  // Solana: programIds; EVM: contract addresses.
  extractIdsFromTxB64(txB64: string, ctx: { rpcUrl: string }): Promise<ExtractIdsResult>;
}
