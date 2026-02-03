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
  sendTx(tx: UnsignedTx, signers?: unknown[]): Promise<TxReceipt>;
  waitForTx(txHash: string): Promise<TxReceipt>;
}

// Chain adapter registry for multi-chain support
export class ChainRegistry {
  private adapters = new Map<ChainName, ChainAdapter>();

  register(adapter: ChainAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  get(chain: ChainName): ChainAdapter {
    const adapter = this.adapters.get(chain);
    if (!adapter) {
      throw new Error(`Chain adapter not found: ${chain}`);
    }
    return adapter;
  }

  has(chain: ChainName): boolean {
    return this.adapters.has(chain);
  }

  list(): ChainName[] {
    return [...this.adapters.keys()];
  }
}
