/**
 * EVM Chain Adapter
 * Supports Ethereum, BSC, Polygon, Arbitrum, etc.
 */

import type { ChainAdapter, Balance, TransferParams, UnsignedTx, SimulationResult, TxReceipt } from "./types.js";

// Common ERC20 ABI fragments
const ERC20_ABI = {
  balanceOf: "function balanceOf(address owner) view returns (uint256)",
  transfer: "function transfer(address to, uint256 amount) returns (bool)",
  decimals: "function decimals() view returns (uint8)",
  symbol: "function symbol() view returns (string)",
  name: "function name() view returns (string)",
};

// Common token addresses by chain
const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export interface EvmAdapterConfig {
  rpcUrl: string;
  chainId: number;
  chainName?: string;
}

// Helper to encode function calls without ethers.js dependency
function encodeFunctionCall(selector: string, params: string[]): string {
  // For now, we'll use a simple encoding for common calls
  // In production, use ethers.js or viem for proper ABI encoding
  return selector + params.map(p => p.replace("0x", "").padStart(64, "0")).join("");
}

function keccak256Selector(signature: string): string {
  // Simple hash for function selector - in production use proper keccak256
  // This is a placeholder that returns common selectors
  const selectors: Record<string, string> = {
    "balanceOf(address)": "0x70a08231",
    "transfer(address,uint256)": "0xa9059cbb",
    "decimals()": "0x313ce567",
    "symbol()": "0x95d89b41",
    "name()": "0x06fdde03",
  };
  return selectors[signature] ?? "0x00000000";
}

export class EvmAdapter implements ChainAdapter {
  name = "evm" as const;
  private config: EvmAdapterConfig;

  constructor(config: EvmAdapterConfig) {
    this.config = config;
  }

  get rpcUrl(): string {
    return this.config.rpcUrl;
  }

  get chainId(): number {
    return this.config.chainId;
  }

  private async rpcCall(method: string, params: any[]): Promise<any> {
    const res = await fetch(this.config.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
    });

    const data = await res.json();
    if (data.error) {
      throw new Error(`RPC error: ${data.error.message ?? JSON.stringify(data.error)}`);
    }
    return data.result;
  }

  async getBalance(address: string, token?: string): Promise<Balance[]> {
    const results: Balance[] = [];

    // Get native balance (ETH/BNB/MATIC/etc.)
    const nativeBalance = await this.rpcCall("eth_getBalance", [address, "latest"]);
    const nativeWei = BigInt(nativeBalance);
    
    results.push({
      token: NATIVE_TOKEN,
      amount: nativeWei.toString(),
      decimals: 18,
    });

    // Get ERC20 balance if token specified
    if (token && token !== NATIVE_TOKEN) {
      try {
        const callData = encodeFunctionCall(
          keccak256Selector("balanceOf(address)"),
          [address]
        );

        const tokenBalance = await this.rpcCall("eth_call", [
          { to: token, data: callData },
          "latest",
        ]);

        const balance = BigInt(tokenBalance);
        
        // Get decimals
        const decimalsData = keccak256Selector("decimals()");
        const decimalsResult = await this.rpcCall("eth_call", [
          { to: token, data: decimalsData },
          "latest",
        ]);
        const decimals = parseInt(decimalsResult, 16);

        results.push({
          token,
          amount: balance.toString(),
          decimals,
        });
      } catch (e) {
        // Token might not exist or not be ERC20
        console.error(`Failed to get token balance for ${token}:`, e);
      }
    }

    return results;
  }

  async buildTransferTx(params: TransferParams): Promise<UnsignedTx> {
    if (!params.fromWalletId) {
      throw new Error("Missing fromWalletId (sender address)");
    }

    const from = params.fromWalletId;
    const to = params.to;
    const amountUi = Number(params.amount);

    if (!Number.isFinite(amountUi) || amountUi <= 0) {
      throw new Error("Invalid amount");
    }

    const isNative = !params.token || params.token === NATIVE_TOKEN;

    // Get nonce
    const nonce = await this.rpcCall("eth_getTransactionCount", [from, "pending"]);

    // Get gas price
    const gasPrice = await this.rpcCall("eth_gasPrice", []);

    let tx: any;

    if (isNative) {
      // Native token transfer
      const valueWei = BigInt(Math.floor(amountUi * 1e18));
      
      tx = {
        from,
        to,
        value: "0x" + valueWei.toString(16),
        nonce,
        gasPrice,
        gas: "0x5208", // 21000 for simple transfer
        chainId: this.config.chainId,
      };
    } else {
      // ERC20 transfer
      // Get token decimals
      const decimalsData = keccak256Selector("decimals()");
      const decimalsResult = await this.rpcCall("eth_call", [
        { to: params.token, data: decimalsData },
        "latest",
      ]);
      const decimals = parseInt(decimalsResult, 16) || 18;

      const amount = BigInt(Math.floor(amountUi * Math.pow(10, decimals)));
      
      // Encode transfer(to, amount)
      const data = encodeFunctionCall(
        keccak256Selector("transfer(address,uint256)"),
        [to, "0x" + amount.toString(16)]
      );

      // Estimate gas
      let gas = "0x10000"; // Default 65536
      try {
        gas = await this.rpcCall("eth_estimateGas", [
          { from, to: params.token, data },
        ]);
      } catch {}

      tx = {
        from,
        to: params.token,
        value: "0x0",
        data,
        nonce,
        gasPrice,
        gas,
        chainId: this.config.chainId,
      };
    }

    // Serialize to base64 (simplified - in production use RLP encoding)
    const txB64 = Buffer.from(JSON.stringify(tx)).toString("base64");

    return {
      chain: "evm",
      txBytesB64: txB64,
      summary: {
        kind: isNative ? "native_transfer" : "erc20_transfer",
        from,
        to,
        amount: amountUi,
        token: params.token || "NATIVE",
        chainId: this.config.chainId,
      },
    };
  }

  async simulateTx(unsignedTx: UnsignedTx): Promise<SimulationResult> {
    try {
      // Decode tx
      const tx = JSON.parse(Buffer.from(unsignedTx.txBytesB64, "base64").toString());

      // Use eth_call to simulate
      const callParams: any = {
        from: tx.from,
        to: tx.to,
        value: tx.value,
        data: tx.data,
        gas: tx.gas,
      };

      await this.rpcCall("eth_call", [callParams, "latest"]);

      // If eth_call succeeds, estimate gas for more accurate result
      const estimatedGas = await this.rpcCall("eth_estimateGas", [callParams]);

      return {
        ok: true,
        data: {
          estimatedGas,
          gasPrice: tx.gasPrice,
        },
      };
    } catch (e: any) {
      return {
        ok: false,
        error: e?.message ?? String(e),
      };
    }
  }

  async sendTx(unsignedTx: UnsignedTx, signers?: unknown[]): Promise<TxReceipt> {
    // In production, this would:
    // 1. Sign the transaction with the provided signer
    // 2. RLP encode and send via eth_sendRawTransaction
    
    // For now, return a placeholder since we don't have signing implementation
    throw new Error("EVM sendTx requires external signing implementation. Use a wallet library like ethers.js or viem.");
  }

  async waitForTx(txHash: string): Promise<TxReceipt> {
    const maxAttempts = 30;
    const delayMs = 2000;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const receipt = await this.rpcCall("eth_getTransactionReceipt", [txHash]);

        if (receipt) {
          const success = receipt.status === "0x1";
          return {
            txHash,
            ok: success,
            data: {
              blockNumber: parseInt(receipt.blockNumber, 16),
              gasUsed: parseInt(receipt.gasUsed, 16),
              status: receipt.status,
            },
          };
        }
      } catch {}

      await new Promise((r) => setTimeout(r, delayMs));
    }

    return {
      txHash,
      ok: false,
      data: { error: "Transaction not confirmed within timeout" },
    };
  }

  // --- EVM-specific methods ---

  async getBlockNumber(): Promise<number> {
    const result = await this.rpcCall("eth_blockNumber", []);
    return parseInt(result, 16);
  }

  async getGasPrice(): Promise<bigint> {
    const result = await this.rpcCall("eth_gasPrice", []);
    return BigInt(result);
  }

  async getTransactionCount(address: string): Promise<number> {
    const result = await this.rpcCall("eth_getTransactionCount", [address, "pending"]);
    return parseInt(result, 16);
  }

  async call(to: string, data: string): Promise<string> {
    return this.rpcCall("eth_call", [{ to, data }, "latest"]);
  }
}

// Factory functions for common chains
export function createBscAdapter(rpcUrl?: string): EvmAdapter {
  return new EvmAdapter({
    rpcUrl: rpcUrl ?? "https://bsc-dataseed.binance.org",
    chainId: 56,
    chainName: "BSC",
  });
}

export function createEthereumAdapter(rpcUrl?: string): EvmAdapter {
  return new EvmAdapter({
    rpcUrl: rpcUrl ?? "https://eth.llamarpc.com",
    chainId: 1,
    chainName: "Ethereum",
  });
}

export function createPolygonAdapter(rpcUrl?: string): EvmAdapter {
  return new EvmAdapter({
    rpcUrl: rpcUrl ?? "https://polygon-rpc.com",
    chainId: 137,
    chainName: "Polygon",
  });
}

export function createArbitrumAdapter(rpcUrl?: string): EvmAdapter {
  return new EvmAdapter({
    rpcUrl: rpcUrl ?? "https://arb1.arbitrum.io/rpc",
    chainId: 42161,
    chainName: "Arbitrum",
  });
}

export function createBaseAdapter(rpcUrl?: string): EvmAdapter {
  return new EvmAdapter({
    rpcUrl: rpcUrl ?? "https://mainnet.base.org",
    chainId: 8453,
    chainName: "Base",
  });
}
