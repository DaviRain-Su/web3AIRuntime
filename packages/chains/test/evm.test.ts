import { describe, test, expect, mock, beforeEach } from "bun:test";
import { EvmAdapter, createBscAdapter, createEthereumAdapter } from "../src/evm.js";

// Mock fetch for testing
const mockFetch = mock((url: string, options: any) => {
  const body = JSON.parse(options.body);
  
  if (body.method === "eth_getBalance") {
    return Promise.resolve({
      json: () => Promise.resolve({
        jsonrpc: "2.0",
        id: body.id,
        result: "0xde0b6b3a7640000", // 1 ETH in wei
      }),
    });
  }
  
  if (body.method === "eth_gasPrice") {
    return Promise.resolve({
      json: () => Promise.resolve({
        jsonrpc: "2.0",
        id: body.id,
        result: "0x3b9aca00", // 1 gwei
      }),
    });
  }
  
  if (body.method === "eth_getTransactionCount") {
    return Promise.resolve({
      json: () => Promise.resolve({
        jsonrpc: "2.0",
        id: body.id,
        result: "0x5", // nonce 5
      }),
    });
  }
  
  if (body.method === "eth_blockNumber") {
    return Promise.resolve({
      json: () => Promise.resolve({
        jsonrpc: "2.0",
        id: body.id,
        result: "0x1234567",
      }),
    });
  }
  
  if (body.method === "eth_call") {
    // Return mock balance for ERC20 balanceOf
    return Promise.resolve({
      json: () => Promise.resolve({
        jsonrpc: "2.0",
        id: body.id,
        result: "0x" + "0".repeat(64), // 0 balance
      }),
    });
  }

  if (body.method === "eth_getTransactionReceipt") {
    return Promise.resolve({
      json: () => Promise.resolve({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          status: "0x1",
          blockNumber: "0x1234567",
          gasUsed: "0x5208",
        },
      }),
    });
  }

  return Promise.resolve({
    json: () => Promise.resolve({
      jsonrpc: "2.0",
      id: body.id,
      error: { message: "Unknown method" },
    }),
  });
});

describe("EvmAdapter", () => {
  let adapter: EvmAdapter;

  beforeEach(() => {
    adapter = new EvmAdapter({
      rpcUrl: "https://test-rpc.example.com",
      chainId: 1,
      chainName: "Test",
    });
    
    // Replace global fetch with mock
    (globalThis as any).fetch = mockFetch;
  });

  test("getBalance returns native balance", async () => {
    const balances = await adapter.getBalance("0x1234567890123456789012345678901234567890");
    
    expect(balances.length).toBeGreaterThan(0);
    expect(balances[0].token).toBe("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE");
    expect(balances[0].decimals).toBe(18);
    expect(BigInt(balances[0].amount)).toBe(BigInt("1000000000000000000")); // 1 ETH
  });

  test("buildTransferTx creates native transfer", async () => {
    const tx = await adapter.buildTransferTx({
      chain: "evm",
      fromWalletId: "0x1234567890123456789012345678901234567890",
      to: "0x0987654321098765432109876543210987654321",
      token: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      amount: "0.1",
    });

    expect(tx.chain).toBe("evm");
    expect(tx.summary.kind).toBe("native_transfer");
    expect(tx.summary.amount).toBe(0.1);
    expect(tx.txBytesB64).toBeDefined();
  });

  test("getBlockNumber returns number", async () => {
    const blockNumber = await adapter.getBlockNumber();
    expect(blockNumber).toBe(0x1234567);
  });

  test("getGasPrice returns bigint", async () => {
    const gasPrice = await adapter.getGasPrice();
    expect(gasPrice).toBe(BigInt("1000000000")); // 1 gwei
  });

  test("waitForTx returns receipt", async () => {
    const receipt = await adapter.waitForTx("0x" + "a".repeat(64));
    expect(receipt.ok).toBe(true);
    expect(receipt.data?.status).toBe("0x1");
  });
});

describe("Factory functions", () => {
  test("createBscAdapter creates BSC adapter", () => {
    const adapter = createBscAdapter();
    expect(adapter.chainId).toBe(56);
  });

  test("createEthereumAdapter creates Ethereum adapter", () => {
    const adapter = createEthereumAdapter();
    expect(adapter.chainId).toBe(1);
  });
});
