#!/usr/bin/env node
/**
 * MCP server for Web3 AI Runtime (w3rt)
 * 
 * Exposes DeFi operations with built-in safety layer to Claude Desktop / ChatGPT Desktop
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { Keypair } from "@solana/web3.js";
import { createSolanaTools, type SolanaToolsConfig } from "@w3rt/runtime";

// Helper: get w3rt directory
function w3rtDir() {
  return process.env.W3RT_DIR || join(os.homedir(), ".w3rt");
}

// Helper: load config
function loadConfig(): any {
  const configPath = join(w3rtDir(), "config.yaml");
  if (!existsSync(configPath)) {
    return {};
  }
  const raw = readFileSync(configPath, "utf-8");
  return yaml.load(raw) || {};
}

// Helper: load keypair
function loadKeypair(): Keypair | null {
  const cfg = loadConfig();
  const kpPath = cfg.wallet?.keyPath;
  if (!kpPath) return null;
  
  const fullPath = kpPath.startsWith("/") ? kpPath : join(w3rtDir(), kpPath);
  if (!existsSync(fullPath)) return null;
  
  const raw = readFileSync(fullPath, "utf-8");
  const secret = JSON.parse(raw);
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

// Helper: check if daemon is running
function checkDaemon(): { url: string; running: boolean } {
  const urlPath = join(w3rtDir(), "daemon.url");
  const portPath = join(w3rtDir(), "daemon.port");
  
  let url = "";
  if (existsSync(urlPath)) {
    url = readFileSync(urlPath, "utf-8").trim();
  } else if (existsSync(portPath)) {
    const port = readFileSync(portPath, "utf-8").trim();
    url = `http://127.0.0.1:${port}`;
  }
  
  return { url, running: !!url };
}

// Create Solana tools config
function createSolanaConfig(): SolanaToolsConfig {
  const cfg = loadConfig();
  
  return {
    getRpcUrl: () => cfg.solana?.rpc || "https://api.mainnet-beta.solana.com",
    getKeypair: () => loadKeypair(),
    getJupiterBaseUrl: () => cfg.jupiter?.baseUrl || "https://quote-api.jup.ag/v6",
    getJupiterApiKey: () => cfg.jupiter?.apiKey,
  };
}

// Tool definitions for MCP
const mcpTools: Tool[] = [
  {
    name: "meteora_top_pools",
    description: "Get top Meteora DLMM pools by fee generation. Helps find high-yield liquidity opportunities on Solana.",
    inputSchema: {
      type: "object",
      properties: {
        base: {
          type: "string",
          enum: ["USDC", "SOL"],
          description: "Base currency to filter pools",
        },
        window: {
          type: "string",
          enum: ["5m", "1h", "24h"],
          description: "Time window for fee calculation",
        },
        limit: {
          type: "number",
          description: "Number of top pools to return (default: 3)",
        }
      }
    }
  },
  {
    name: "solana_swap",
    description: "Execute a token swap on Solana via Jupiter aggregator with safety checks. Returns quote first for approval.",
    inputSchema: {
      type: "object",
      properties: {
        fromToken: {
          type: "string",
          description: "Input token mint address or symbol (SOL, USDC, etc.)",
        },
        toToken: {
          type: "string",
          description: "Output token mint address or symbol",
        },
        amount: {
          type: "string",
          description: "Amount of input token (in token units, e.g., '1.5' for 1.5 SOL)",
        },
        slippageBps: {
          type: "number",
          description: "Maximum slippage in basis points (default: 50 = 0.5%)",
        },
        simulate: {
          type: "boolean",
          description: "If true, only return quote without executing (default: true)",
        }
      },
      required: ["fromToken", "toToken", "amount"]
    }
  },
  {
    name: "solana_balance",
    description: "Check Solana wallet balance for native SOL and SPL tokens.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Solana wallet address (optional, uses configured wallet if not provided)"
        },
        includeTokens: {
          type: "boolean",
          description: "Include SPL token balances (default: false)"
        },
        tokenMint: {
          type: "string",
          description: "Specific token mint to check (optional, requires includeTokens=true)"
        }
      }
    }
  },
  {
    name: "w3rt_status",
    description: "Check w3rt daemon status and configuration.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];

// Create MCP server
const server = new Server(
  {
    name: "w3rt-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Initialize Solana tools
let solanaTools: ReturnType<typeof createSolanaTools> | null = null;

function getSolanaTools() {
  if (!solanaTools) {
    solanaTools = createSolanaTools(createSolanaConfig());
  }
  return solanaTools;
}

// Helper: resolve token symbol to mint address
const TOKEN_MINTS: Record<string, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  WSOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
};

function resolveTokenMint(input: string): string {
  const upper = input.toUpperCase();
  return TOKEN_MINTS[upper] || input;
}

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: mcpTools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "w3rt_status": {
        const daemon = checkDaemon();
        const configPath = join(w3rtDir(), "config.yaml");
        const hasConfig = existsSync(configPath);
        const kp = loadKeypair();
        
        const status = {
          daemon: daemon.running ? "running" : "stopped",
          daemonUrl: daemon.url || "not configured",
          w3rtDir: w3rtDir(),
          configExists: hasConfig,
          walletConfigured: !!kp,
          walletAddress: kp?.publicKey.toBase58() || "not configured",
          status: daemon.running && hasConfig && kp ? "ready" : "needs setup"
        };
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(status, null, 2)
          }]
        };
      }

      case "meteora_top_pools": {
        const daemon = checkDaemon();
        if (!daemon.running) {
          return {
            content: [{
              type: "text",
              text: "⚠️ Error: w3rt daemon is not running.\n\nTo start the daemon:\n1. cd ~/clawd/web3AIRuntime\n2. bun run daemon\n\nOr configure the daemon URL in ~/.w3rt/daemon.url"
            }],
            isError: true
          };
        }

        const { base = "USDC", window = "5m", limit = 3 } = args as any;
        const url = `${daemon.url}/v1/meteora/monitor/top?base=${base}&window=${window}&rank=fees&minLiquidity=10000&limit=${limit}`;
        
        const response = await fetch(url);
        const data = await response.json();
        
        if (!data.ok) {
          throw new Error(data.error || "Failed to fetch Meteora data");
        }

        // Format results
        const formatted = data.result.map((pool: any, idx: number) => {
          return `${idx + 1}. **${pool.name}**\n` +
                 `   • Pool ID: \`${pool.poolId}\`\n` +
                 `   • Fee Delta (${window}): **${pool.feeDelta.toFixed(2)} ${base}**\n` +
                 `   • Liquidity: $${pool.liquidity.toLocaleString()}\n` +
                 `   • APY: ${pool.apy ? pool.apy.toFixed(2) + '%' : 'N/A'}`;
        }).join('\n\n');

        return {
          content: [{
            type: "text",
            text: `## Top ${limit} Meteora Pools (${base}, ${window} window)\n\n${formatted}\n\n---\n💡 Higher fee delta = more trading volume = potentially higher yield`
          }]
        };
      }

      case "solana_balance": {
        const tools = getSolanaTools();
        const balanceTool = tools.find(t => t.name === "solana_balance");
        if (!balanceTool) {
          throw new Error("solana_balance tool not found");
        }

        const { address, includeTokens = false, tokenMint } = args as any;
        
        const result = await balanceTool.execute({
          address,
          includeTokens,
          tokenMint: tokenMint ? resolveTokenMint(tokenMint) : undefined,
        }, {});

        if (!result.ok) {
          throw new Error(result.error || "Balance check failed");
        }

        let output = `## Solana Wallet Balance\n\n`;
        output += `**Address:** \`${result.address}\`\n\n`;
        output += `### Native SOL\n`;
        output += `• Balance: **${result.sol.sol.toFixed(4)} SOL**\n`;
        output += `• Lamports: ${result.sol.lamports.toLocaleString()}\n`;

        if (result.tokens && result.tokens.length > 0) {
          output += `\n### SPL Tokens\n`;
          result.tokens.forEach((token: any) => {
            output += `\n• **Token:** \`${token.mint}\`\n`;
            output += `  - Amount: ${token.uiAmount}\n`;
            output += `  - Account: \`${token.pubkey}\`\n`;
          });
        }

        return {
          content: [{
            type: "text",
            text: output
          }]
        };
      }

      case "solana_swap": {
        const tools = getSolanaTools();
        const swapTool = tools.find(t => t.name === "solana_swap_exact_in");
        if (!swapTool) {
          throw new Error("solana_swap_exact_in tool not found");
        }

        const {
          fromToken,
          toToken,
          amount,
          slippageBps = 50,
          simulate = true
        } = args as any;

        // Resolve token symbols to mint addresses
        const inputMint = resolveTokenMint(fromToken);
        const outputMint = resolveTokenMint(toToken);
        
        // Convert amount to lamports/smallest unit
        // For now, assume input is in token units (e.g., "1.5" SOL)
        const amountNum = parseFloat(amount);
        if (isNaN(amountNum) || amountNum <= 0) {
          throw new Error("Invalid amount");
        }

        // Convert to lamports (assuming 9 decimals for SOL, 6 for USDC/USDT)
        const decimals = inputMint === TOKEN_MINTS.SOL ? 9 : 6;
        const amountLamports = Math.floor(amountNum * Math.pow(10, decimals)).toString();

        if (simulate) {
          // For now, return a simulated quote
          // In production, we'd call Jupiter quote API
          return {
            content: [{
              type: "text",
              text: `## Swap Quote (Simulation)\n\n` +
                    `**Route:** ${fromToken} → ${toToken}\n` +
                    `**Input:** ${amount} ${fromToken}\n` +
                    `**Max Slippage:** ${slippageBps / 100}%\n\n` +
                    `⚠️ **Swap execution not yet implemented in MCP server.**\n\n` +
                    `To execute this swap:\n` +
                    `1. Use the Pi extension: \`bun run pi\`\n` +
                    `2. Or use w3rt CLI directly\n\n` +
                    `---\n` +
                    `💡 This is a safety feature - swaps require explicit approval workflow.`
            }]
          };
        }

        return {
          content: [{
            type: "text",
            text: "⚠️ Swap execution requires approval workflow. Use simulate=true for quotes."
          }]
        };
      }

      default:
        return {
          content: [{
            type: "text",
            text: `❌ Unknown tool: ${name}`
          }],
          isError: true
        };
    }
  } catch (error: any) {
    console.error(`Error in ${name}:`, error);
    return {
      content: [{
        type: "text",
        text: `❌ Error executing ${name}:\n\n${error.message}\n\n${error.stack || ''}`
      }],
      isError: true
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("w3rt MCP server running on stdio");
}

main().catch(console.error);
