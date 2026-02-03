import type { Tool, Dict } from "./types.js";
import { createEthereumAdapter } from "@w3rt/chains";

function rpcUrl(): string {
  return process.env.W3RT_EVM_RPC_URL || "https://eth.llamarpc.com";
}

function chainId(): number {
  const n = Number(process.env.W3RT_EVM_CHAIN_ID || 1);
  return Number.isFinite(n) ? n : 1;
}

export function createEvmTools(): Tool[] {
  return [
    {
      name: "evm_simulate_tx",
      meta: { chain: "evm", action: "simulate", sideEffect: "none", risk: "low" },
      async execute(params: Dict) {
        const tx = JSON.parse(Buffer.from(String(params.txB64), "base64").toString("utf-8"));
        const evm = createEthereumAdapter(rpcUrl());
        // We reuse chain adapter simulation logic by wrapping JSON tx into UnsignedTx shape.
        const sim = await evm.simulateTx({ chain: "evm", txBytesB64: Buffer.from(JSON.stringify(tx)).toString("base64"), summary: {} as any });
        return sim;
      },
    },
  ];
}
