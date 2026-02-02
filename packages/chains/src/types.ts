export type ChainName = "solana" | "sui" | "evm";

export interface Balance {
  token: string;
  amount: string;
  decimals?: number;
}

export interface TransferParams {
  chain: ChainName;
  fromWalletId?: string;
  to: string;
  token: string;
  amount: string;
}

export interface UnsignedTx {
  chain: ChainName;
  txBytesB64: string;
  summary: Record<string, unknown>;
}

export interface SimulationResult {
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

export interface TxReceipt {
  txHash: string;
  ok: boolean;
  data?: Record<string, unknown>;
}

export interface ChainAdapter {
  name: ChainName;
  getBalance(address: string, token?: string): Promise<Balance[]>;
  buildTransferTx(params: TransferParams): Promise<UnsignedTx>;
  simulateTx(tx: UnsignedTx): Promise<SimulationResult>;
  sendTx(tx: UnsignedTx): Promise<TxReceipt>;
  waitForTx(txHash: string): Promise<TxReceipt>;
}
