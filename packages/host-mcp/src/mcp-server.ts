#!/usr/bin/env node
/**
 * MCP server for Web3 AI Runtime (w3rt)
 *
 * Exposes DeFi operations with built-in safety layer to Claude Desktop / ChatGPT Desktop.
 *
 * Security model:
 * - Reads config from ${W3RT_DIR:-~/.w3rt}/config.yaml
 * - Wallet keypair is required for any signing action
 * - Swap execution is two-step (quote -> execute) with explicit confirm phrase
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import yaml from "js-yaml";
import { Keypair } from "@solana/web3.js";

import { createSolanaTools, type SolanaToolsConfig } from "@w3rt/runtime";

type Dict = Record<string, any>;

function w3rtDir() {
  return process.env.W3RT_DIR || join(os.homedir(), ".w3rt");
}

function loadConfig(): any {
  const configPath = join(w3rtDir(), "config.yaml");
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, "utf-8");
  return yaml.load(raw) || {};
}

function loadKeypair(): Keypair | null {
  const cfg = loadConfig();
  const kpPath = cfg.wallet?.keyPath;
  if (!kpPath) return null;

  // Note: we intentionally DO NOT expand "~" here; require absolute or W3RT_DIR-relative.
  const fullPath = String(kpPath).startsWith("/") ? String(kpPath) : join(w3rtDir(), String(kpPath));
  if (!existsSync(fullPath)) return null;

  const raw = readFileSync(fullPath, "utf-8");
  const secret = JSON.parse(raw);
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function checkDaemon(): { url: string; running: boolean } {
  const urlPath = join(w3rtDir(), "daemon.url");
  const portPath = join(w3rtDir(), "daemon.port");

  let url = "";
  if (existsSync(urlPath)) url = readFileSync(urlPath, "utf-8").trim();
  else if (existsSync(portPath)) {
    const port = readFileSync(portPath, "utf-8").trim();
    url = `http://127.0.0.1:${port}`;
  }

  return { url, running: !!url };
}

function createSolanaConfig(): SolanaToolsConfig {
  const cfg = loadConfig();
  return {
    getRpcUrl: () => cfg.solana?.rpc || "https://api.mainnet-beta.solana.com",
    getKeypair: () => loadKeypair(),
    getJupiterBaseUrl: () => cfg.jupiter?.baseUrl || "https://quote-api.jup.ag/v6",
    getJupiterApiKey: () => cfg.jupiter?.apiKey,
  };
}

// Runtime tools (Solana)
let solanaTools: ReturnType<typeof createSolanaTools> | null = null;
function getSolanaTools() {
  if (!solanaTools) solanaTools = createSolanaTools(createSolanaConfig());
  return solanaTools;
}

// Token symbol -> mint shortcut
const TOKEN_MINTS: Record<string, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  WSOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
};
function resolveTokenMint(input: string): string {
  const upper = String(input).trim().toUpperCase();
  return TOKEN_MINTS[upper] || String(input).trim();
}

function getPolicyLimits() {
  const cfg = loadConfig();
  const p = cfg.policy || {};
  return {
    maxSlippageBps: typeof p.maxSlippageBps === "number" ? p.maxSlippageBps : 100, // 1%
    // default hard caps if not configured
    maxSwapInputSol: typeof p.maxSwapInputSol === "number" ? p.maxSwapInputSol : 0.25,
    maxSwapInputUsdc: typeof p.maxSwapInputUsdc === "number" ? p.maxSwapInputUsdc : 250,
    requireConfirmPhrase: p.requireConfirmPhrase ?? "I_CONFIRM",
  };
}

function formatSolscan(sig: string) {
  return `https://solscan.io/tx/${sig}`;
}

// In-memory quote store for 2-step swaps
type StoredQuote = {
  createdAtMs: number;
  expiresAtMs: number;
  quoteId: string;
  inputMint: string;
  outputMint: string;
  amountLamports: string;
  slippageBps: number;
  ctx: Dict;
};
const QUOTE_TTL_MS = 2 * 60 * 1000;
const quotes = new Map<string, StoredQuote>();

function putQuote(q: Omit<StoredQuote, "createdAtMs" | "expiresAtMs">) {
  const now = Date.now();
  quotes.set(q.quoteId, { ...q, createdAtMs: now, expiresAtMs: now + QUOTE_TTL_MS });
}

function getQuote(quoteId: string): StoredQuote {
  const q = quotes.get(quoteId);
  if (!q) throw new Error(`Unknown quoteId: ${quoteId}`);
  if (Date.now() > q.expiresAtMs) {
    quotes.delete(quoteId);
    throw new Error(`quoteId expired: ${quoteId} (TTL ${Math.round(QUOTE_TTL_MS / 1000)}s)`);
  }
  return q;
}

// MCP tool definitions
const mcpTools: Tool[] = [
  {
    name: "w3rt_status",
    description: "Check w3rt daemon status, config, and wallet setup.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "solana_balance",
    description: "Check Solana wallet balance for native SOL and SPL tokens.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Solana address (optional; uses configured keypair if omitted)" },
        includeTokens: { type: "boolean", description: "Include SPL token accounts (default false)" },
        tokenMint: { type: "string", description: "Specific token mint/symbol (requires includeTokens=true)" },
      },
    },
  },
  {
    name: "meteora_top_pools",
    description: "Get top Meteora DLMM pools by fee generation (requires w3rt daemon).",
    inputSchema: {
      type: "object",
      properties: {
        base: { type: "string", enum: ["USDC", "SOL"], default: "USDC" },
        window: { type: "string", enum: ["5m", "1h", "24h"], default: "5m" },
        limit: { type: "number", default: 3 },
      },
    },
  },

  // Swap (two-step)
  {
    name: "solana_swap_quote",
    description: "Step 1/2: Request a Jupiter swap quote and create a short-lived quoteId (then use solana_swap_execute).",
    inputSchema: {
      type: "object",
      properties: {
        fromToken: { type: "string", description: "Input token mint or symbol (SOL/USDC/USDT or mint)" },
        toToken: { type: "string", description: "Output token mint or symbol" },
        amount: { type: "string", description: "Amount in token units (e.g. '0.1' SOL, '25' USDC)" },
        slippageBps: { type: "number", description: "Slippage in bps (default from policy)" },
      },
      required: ["fromToken", "toToken", "amount"],
    },
  },
  {
    name: "solana_swap_execute",
    description: "Step 2/2: Execute a previously quoted swap by quoteId. Requires explicit confirm phrase.",
    inputSchema: {
      type: "object",
      properties: {
        quoteId: { type: "string", description: "Quote id returned by solana_swap_quote" },
        confirm: { type: "string", description: "Must equal the confirm phrase (default: I_CONFIRM)" },
      },
      required: ["quoteId", "confirm"],
    },
  },

  // Backwards-compatible alias (quote only)
  {
    name: "solana_swap",
    description: "Alias of solana_swap_quote (quote-only).",
    inputSchema: {
      type: "object",
      properties: {
        fromToken: { type: "string" },
        toToken: { type: "string" },
        amount: { type: "string" },
        slippageBps: { type: "number" },
      },
      required: ["fromToken", "toToken", "amount"],
    },
  },
];

const server = new Server(
  { name: "w3rt-mcp-server", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools }));

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
          w3rtDir: w3rtDir(),
          configExists: hasConfig,
          walletConfigured: !!kp,
          walletAddress: kp?.publicKey.toBase58() || "not configured",
          daemon: daemon.running ? "running" : "stopped",
          daemonUrl: daemon.url || "not configured",
          policy: getPolicyLimits(),
        };

        return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
      }

      case "solana_balance": {
        const tools = getSolanaTools();
        const tool = tools.find((t) => t.name === "solana_balance");
        if (!tool) throw new Error("solana_balance tool not found in runtime");

        const { address, includeTokens = false, tokenMint } = (args as any) || {};
        const result = await tool.execute(
          {
            address,
            includeTokens,
            tokenMint: tokenMint ? resolveTokenMint(tokenMint) : undefined,
          },
          {}
        );

        if (!result?.ok) throw new Error(result?.error || "Balance check failed");

        let out = `## Solana Wallet Balance\n\n`;
        out += `**Address:** \`${result.address}\`\n\n`;
        out += `### Native SOL\n`;
        out += `• Balance: **${Number(result.sol.sol).toFixed(4)} SOL**\n`;
        out += `• Lamports: ${Number(result.sol.lamports).toLocaleString()}\n`;

        if (Array.isArray(result.tokens) && result.tokens.length > 0) {
          out += `\n### SPL Tokens (${result.tokens.length})\n`;
          for (const t of result.tokens) {
            out += `\n• Mint: \`${t.mint}\` | uiAmount: **${t.uiAmount}**\n  Account: \`${t.pubkey}\``;
          }
          out += "\n";
        }

        return { content: [{ type: "text", text: out }] };
      }

      case "meteora_top_pools": {
        const daemon = checkDaemon();
        if (!daemon.running) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  "⚠️ w3rt daemon is not running or not configured.\n\n" +
                  "Fix: set ~/.w3rt/daemon.url (e.g. http://127.0.0.1:38135) or start your daemon.",
              },
            ],
          };
        }

        const { base = "USDC", window = "5m", limit = 3 } = (args as any) || {};
        const url = `${daemon.url}/v1/meteora/monitor/top?base=${base}&window=${window}&rank=fees&minLiquidity=10000&limit=${limit}`;
        const res = await fetch(url);
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Failed to fetch meteora data");

        const formatted = (data.result || []).map((p: any, i: number) => {
          return `${i + 1}. **${p.name}** | feeΔ ${Number(p.feeDelta).toFixed(2)} | liq ${p.liquidity}`;
        });

        return {
          content: [
            {
              type: "text",
              text: `## Meteora Top Pools (${base}, ${window})\n\n${formatted.join("\n")}`,
            },
          ],
        };
      }

      case "solana_swap":
      case "solana_swap_quote": {
        const kp = loadKeypair();
        if (!kp) throw new Error("Wallet not configured. Set wallet.keyPath in ~/.w3rt/config.yaml.");

        const { fromToken, toToken, amount, slippageBps } = (args as any) || {};
        const inputMint = resolveTokenMint(fromToken);
        const outputMint = resolveTokenMint(toToken);

        const amtNum = Number.parseFloat(String(amount));
        if (!Number.isFinite(amtNum) || amtNum <= 0) throw new Error("Invalid amount");

        const limits = getPolicyLimits();
        const slip = slippageBps != null ? Number(slippageBps) : limits.maxSlippageBps;
        if (!Number.isFinite(slip) || slip <= 0) throw new Error("Invalid slippageBps");
        if (slip > limits.maxSlippageBps) {
          throw new Error(`slippageBps ${slip} exceeds policy maxSlippageBps ${limits.maxSlippageBps}`);
        }

        // Basic amount caps (mainnet safety). For non-SOL inputs, cap USDC/USDT amounts.
        const upperFrom = String(fromToken).trim().toUpperCase();
        if (upperFrom === "SOL" || inputMint === TOKEN_MINTS.SOL) {
          if (amtNum > limits.maxSwapInputSol) {
            throw new Error(`Amount ${amtNum} SOL exceeds policy maxSwapInputSol ${limits.maxSwapInputSol}`);
          }
        }
        if (upperFrom === "USDC" || upperFrom === "USDT") {
          if (amtNum > limits.maxSwapInputUsdc) {
            throw new Error(`Amount ${amtNum} exceeds policy maxSwapInputUsdc ${limits.maxSwapInputUsdc}`);
          }
        }

        // Convert user units -> smallest units (heuristic: SOL=9, USDC/USDT=6). Advanced: fetch mint decimals.
        const decimals = inputMint === TOKEN_MINTS.SOL ? 9 : 6;
        const amountLamports = Math.floor(amtNum * Math.pow(10, decimals)).toString();

        const tools = getSolanaTools();
        const quoteTool = tools.find((t) => t.name === "solana_jupiter_quote");
        if (!quoteTool) throw new Error("solana_jupiter_quote tool not found in runtime");

        const ctx: Dict = {};
        const quoteOut = await quoteTool.execute(
          { inputMint, outputMint, amount: amountLamports, slippageBps: slip },
          ctx
        );
        if (!quoteOut?.ok) throw new Error(quoteOut?.error || "Quote failed");

        // Store ctx + normalized params to support build+send later
        putQuote({
          quoteId: quoteOut.quoteId,
          inputMint,
          outputMint,
          amountLamports,
          slippageBps: slip,
          ctx,
        });

        const expiresInSec = Math.round(QUOTE_TTL_MS / 1000);
        const confirmPhrase = limits.requireConfirmPhrase;

        return {
          content: [
            {
              type: "text",
              text:
                `## Swap Quote (Step 1/2)\n\n` +
                `**From:** ${fromToken} (${inputMint})\n` +
                `**To:** ${toToken} (${outputMint})\n` +
                `**Amount (smallest units):** ${amountLamports}\n` +
                `**Slippage:** ${slip} bps\n\n` +
                `**quoteId:** \`${quoteOut.quoteId}\` (expires in ~${expiresInSec}s)\n\n` +
                `Next: call **solana_swap_execute** with:\n` +
                `- quoteId: \`${quoteOut.quoteId}\`\n` +
                `- confirm: \"${confirmPhrase}\"\n\n` +
                `Safety: execution requires explicit confirm phrase to prevent accidental/duplicate swaps.`,
            },
          ],
        };
      }

      case "solana_swap_execute": {
        const kp = loadKeypair();
        if (!kp) throw new Error("Wallet not configured. Set wallet.keyPath in ~/.w3rt/config.yaml.");

        const { quoteId, confirm } = (args as any) || {};
        const limits = getPolicyLimits();
        if (String(confirm) !== String(limits.requireConfirmPhrase)) {
          throw new Error(`Missing/invalid confirm phrase. Set confirm=\"${limits.requireConfirmPhrase}\" to execute.`);
        }

        const q = getQuote(String(quoteId));

        const tools = getSolanaTools();
        const buildTool = tools.find((t) => t.name === "solana_jupiter_build_tx");
        const simTool = tools.find((t) => t.name === "solana_simulate_tx");
        const sendTool = tools.find((t) => t.name === "solana_send_tx");
        const confTool = tools.find((t) => t.name === "solana_confirm_tx");
        if (!buildTool || !simTool || !sendTool || !confTool) {
          throw new Error("Runtime missing one of required tx tools (build/sim/send/confirm)");
        }

        // Build tx from stored ctx
        const buildOut = await buildTool.execute({ quoteId: q.quoteId }, q.ctx);
        if (!buildOut?.ok) throw new Error(buildOut?.error || "Build tx failed");

        // Simulate first (fail closed)
        const simOut = await simTool.execute({ txB64: buildOut.txB64 }, q.ctx);
        if (!simOut?.ok) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `## Swap Simulation Failed (No funds moved)\n\n` +
                  `quoteId: \`${q.quoteId}\`\n\n` +
                  `err: ${JSON.stringify(simOut?.err ?? null)}\n\n` +
                  `logs (first 30):\n` +
                  `${(simOut?.logs || []).slice(0, 30).join("\n")}`,
              },
            ],
          };
        }

        // Send + confirm
        const sendOut = await sendTool.execute({ txB64: buildOut.txB64 }, q.ctx);
        if (!sendOut?.ok) throw new Error(sendOut?.error || "Send failed");

        const confOut = await confTool.execute({ signature: sendOut.signature }, q.ctx);
        if (!confOut?.ok) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `## Swap Sent but Confirmation Failed\n\n` +
                  `signature: \`${sendOut.signature}\`\n` +
                  `Solscan: ${formatSolscan(sendOut.signature)}\n\n` +
                  `err: ${JSON.stringify(confOut?.err ?? null)}`,
              },
            ],
          };
        }

        // One-time use quoteId
        quotes.delete(q.quoteId);

        return {
          content: [
            {
              type: "text",
              text:
                `## Swap Executed ✅\n\n` +
                `signature: \`${sendOut.signature}\`\n` +
                `Solscan: ${formatSolscan(sendOut.signature)}\n\n` +
                `Simulation (unitsConsumed): ${simOut.unitsConsumed ?? "n/a"}\n` +
                `SimulatedOutAmount: ${simOut.simulatedOutAmount ?? "n/a"}\n\n` +
                `Note: This used a 2-step confirmation flow for safety (quoteId was one-time and expired quickly).`,
            },
          ],
        };
      }

      default:
        return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
  } catch (error: any) {
    console.error(`Error in ${name}:`, error);
    return {
      isError: true,
      content: [{ type: "text", text: `Error executing ${name}: ${error?.message || String(error)}` }],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("w3rt MCP server running on stdio");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
