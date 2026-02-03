/**
 * Workflow runner using the modular WorkflowEngine.
 * This is the new implementation that uses @w3rt/workflow engine.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import yaml from "js-yaml";

import {
  WorkflowEngine,
  parseWorkflowFile,
  type ToolDefinition,
  type Dict,
} from "@w3rt/workflow";
import { TraceStore } from "@w3rt/trace";
import { PolicyEngine, type PolicyConfig, type PolicyContext } from "@w3rt/policy";
import { SolanaAdapter } from "@w3rt/chains";

import { loadMetricsSnapshot } from "./metricsSnapshot.js";
import { getActiveSolanaRpc, isLikelyRpcError, rotateSolanaRpc } from "./rpcFailover.js";
import { getActiveJupiterBaseUrl, rotateJupiterBaseUrl } from "./jupiterFailover.js";
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  clusterApiUrl,
} from "@solana/web3.js";

import { createMockTools } from "./tools/mock.js";
import { createSolanaTools } from "./tools/solana.js";
import { createMetricsTools } from "./tools/metrics.js";
import type { Tool } from "./tools/types.js";

import {
  appendLearningEvent,
  ensureLearningStore,
  getLearningStore,
  loadLearningRules,
  matchRule,
} from "./learnings/index.js";

// --- Config helpers ---

function defaultW3rtDir() {
  return join(os.homedir(), ".w3rt");
}

function loadSolanaCliConfig(): { rpcUrl?: string; keypairPath?: string } {
  try {
    const p = join(os.homedir(), ".config", "solana", "cli", "config.yml");
    const cfg = yaml.load(readFileSync(p, "utf-8")) as any;
    return { rpcUrl: cfg?.json_rpc_url, keypairPath: cfg?.keypair_path };
  } catch {
    return {};
  }
}

export function loadSolanaKeypair(): Keypair | null {
  const raw = process.env.W3RT_SOLANA_PRIVATE_KEY;
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return Keypair.fromSecretKey(Uint8Array.from(arr));
    } catch {}
  }

  const kpPath = process.env.W3RT_SOLANA_KEYPAIR_PATH || loadSolanaCliConfig().keypairPath;
  if (kpPath) {
    try {
      const arr = JSON.parse(readFileSync(kpPath, "utf-8"));
      if (Array.isArray(arr)) return Keypair.fromSecretKey(Uint8Array.from(arr));
    } catch {}
  }

  return null;
}

export function resolveSolanaRpc(w3rtDir?: string): string {
  // Prefer configured failover pool if present.
  // If W3RT_SOLANA_RPC_URLS is set, rpcFailover will pick current active.
  const active = getActiveSolanaRpc(w3rtDir);
  if (active) return active;

  if (process.env.W3RT_SOLANA_RPC_URL) return process.env.W3RT_SOLANA_RPC_URL;
  const cli = loadSolanaCliConfig();
  if (cli.rpcUrl) return cli.rpcUrl;
  const cluster = (process.env.W3RT_SOLANA_CLUSTER as any) || "devnet";
  return clusterApiUrl(cluster);
}

function inferNetworkFromRpcUrl(rpcUrl: string): "mainnet" | "testnet" {
  const u = rpcUrl.toLowerCase();
  if (u.includes("mainnet")) return "mainnet";
  return "testnet";
}

function getJupiterBaseUrl(w3rtDir?: string): string {
  return getActiveJupiterBaseUrl(w3rtDir);
}

function getJupiterApiKey(): string | undefined {
  return process.env.W3RT_JUPITER_API_KEY;
}

// --- Broadcast history for rate limiting ---

type BroadcastHistoryState = { timestampsMs: number[] };

function loadBroadcastHistory(statePath: string): BroadcastHistoryState {
  try {
    const raw = readFileSync(statePath, "utf-8");
    const j = JSON.parse(raw);
    const ts = Array.isArray(j?.timestampsMs) ? j.timestampsMs.filter((n: any) => Number.isFinite(n)) : [];
    return { timestampsMs: ts };
  } catch {
    return { timestampsMs: [] };
  }
}

function saveBroadcastHistory(statePath: string, st: BroadcastHistoryState) {
  const pruned = st.timestampsMs.filter((n) => Number.isFinite(n)).slice(-1000);
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ timestampsMs: pruned }, null, 2));
  } catch {}
}

// --- Extract program IDs from Solana tx ---

async function extractSolanaProgramIds(txB64: string, rpcUrl: string): Promise<{ known: boolean; ids: string[] }> {
  try {
    const raw = Buffer.from(txB64, "base64");
    const tx = VersionedTransaction.deserialize(raw);
    const conn = new Connection(rpcUrl, { commitment: "processed" });

    const lookups = tx.message.addressTableLookups ?? [];
    const altAccounts: AddressLookupTableAccount[] = [];

    for (const l of lookups) {
      const key = new PublicKey(l.accountKey);
      const res = await conn.getAddressLookupTable(key);
      if (res.value) altAccounts.push(res.value);
    }

    const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: altAccounts });
    const programIds = new Set<string>();

    for (const ix of tx.message.compiledInstructions) {
      const pk = keys.get(ix.programIdIndex);
      if (pk) programIds.add(pk.toBase58());
    }

    return { known: true, ids: [...programIds] };
  } catch {
    return { known: false, ids: [] };
  }
}

// --- Load policy config ---

function loadPolicyConfig(w3rtDir: string): PolicyConfig {
  const policyPath = join(w3rtDir, "policy.yaml");
  try {
    const raw = readFileSync(policyPath, "utf-8");
    return yaml.load(raw) as PolicyConfig;
  } catch {
    // Default safe policy
    return {
      networks: {
        mainnet: { enabled: true, requireApproval: true, requireSimulation: true, maxDailyVolumeUsd: 500 },
        testnet: { enabled: true, requireApproval: false },
      },
      transactions: {
        maxSingleAmountUsd: 100,
        maxSlippageBps: 100,
        requireConfirmation: "large",
      },
      allowlist: {
        actions: ["swap", "transfer", "balance", "quote", "simulate", "confirm"],
      },
      rules: [],
    };
  }
}

// --- Convert our Tool to WorkflowEngine ToolDefinition ---

type LearningCtx = {
  w3rtDir: string;
  runId: string;
  getStage: () => string | undefined;
};

function convertToEngineTool(tool: Tool, learningCtx: LearningCtx): ToolDefinition {
  const store = getLearningStore(learningCtx.w3rtDir);
  ensureLearningStore(store);

  // Load rules once per tool conversion (good enough for now)
  const rules = loadLearningRules(store);

  return {
    name: tool.name,
    meta: {
      action: tool.meta.action,
      sideEffect: tool.meta.sideEffect,
      chain: tool.meta.chain,
      risk: tool.meta.risk as "low" | "medium" | "high" | undefined,
    },
    execute: async (params: any, ctx: any) => {
      const ts = new Date().toISOString();
      try {
        const res = await tool.execute(params, ctx);
        appendLearningEvent(store, {
          ts,
          runId: learningCtx.runId,
          stage: learningCtx.getStage(),
          tool: tool.name,
          action: tool.meta.action,
          chain: tool.meta.chain,
          ok: !!res?.ok,
          // Keep small: don't dump huge blobs into learnings by default
          params: summarizeParams(params),
        });
        return res;
      } catch (e: any) {
        const errMsg = String(e?.message ?? e);
        const errCode = String(e?.code ?? "ERROR");

        // RPC failover (best-effort): rotate to next endpoint on likely network/RPC errors.
        if (tool.meta.chain === "solana" && isLikelyRpcError(e)) {
          rotateSolanaRpc(learningCtx.w3rtDir, `${errCode}: ${errMsg}`);
        }

        // Jupiter base URL failover (best-effort)
        if (tool.name.startsWith("solana_jupiter_") && isLikelyRpcError(e)) {
          rotateJupiterBaseUrl(learningCtx.w3rtDir, `${errCode}: ${errMsg}`);
        }

        // best-effort: tag known failures with an "applied_fix" if a rule matches.
        const rule = matchRule(rules, {
          tool: tool.name,
          action: tool.meta.action,
          chain: tool.meta.chain,
          error_code: errCode,
          error_message: errMsg,
        });

        appendLearningEvent(store, {
          ts,
          runId: learningCtx.runId,
          stage: learningCtx.getStage(),
          tool: tool.name,
          action: tool.meta.action,
          chain: tool.meta.chain,
          ok: false,
          error_code: errCode,
          error_message: errMsg,
          params: summarizeParams(params),
          applied_fix: rule?.effect?.applied_fix,
        });

        throw e;
      }
    },
  };
}

function summarizeParams(params: any) {
  // Avoid leaking secrets and avoid huge writes.
  if (!params || typeof params !== "object") return params;
  const out: any = Array.isArray(params) ? [] : {};
  const keys = Object.keys(params).slice(0, 50);
  for (const k of keys) {
    if (k.toLowerCase().includes("secret") || k.toLowerCase().includes("key") || k.toLowerCase().includes("private")) {
      out[k] = "[redacted]";
      continue;
    }
    const v = (params as any)[k];
    if (typeof v === "string" && v.length > 500) out[k] = v.slice(0, 500) + "…";
    else out[k] = v;
  }
  return out;
}

// --- Runner options ---

export interface RunnerOptions {
  w3rtDir?: string;
  approve?: (prompt: string) => Promise<boolean>;
}

// --- Main runner function ---

export async function runWorkflow(workflowPath: string, opts: RunnerOptions = {}) {
  const w3rtDir = opts.w3rtDir ?? defaultW3rtDir();
  const runId = `run_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

  // Parse workflow
  const parseResult = parseWorkflowFile(workflowPath);
  if (!parseResult.ok || !parseResult.workflow) {
    throw new Error(`Failed to parse workflow: ${parseResult.errors?.join(", ")}`);
  }
  const workflow = parseResult.workflow;

  // Initialize trace store
  const trace = new TraceStore(w3rtDir);

  // Load policy
  const policyConfig = loadPolicyConfig(w3rtDir);
  const policy = new PolicyEngine(policyConfig);

  // Create tools
  const mockTools = createMockTools();
  const solanaTools = createSolanaTools({
    getRpcUrl: () => resolveSolanaRpc(w3rtDir),
    getKeypair: loadSolanaKeypair,
    getJupiterBaseUrl: () => getJupiterBaseUrl(w3rtDir),
    getJupiterApiKey: getJupiterApiKey,
  });

  const metricsTools = createMetricsTools();

  const allTools = [...mockTools, ...solanaTools, ...metricsTools];
  const learningCtx: LearningCtx = {
    w3rtDir,
    runId,
    getStage: () => undefined,
  };
  const toolMap = new Map(allTools.map((t) => [t.name, convertToEngineTool(t, learningCtx)]));

  // Broadcast history for rate limiting
  const histPath = join(w3rtDir, "policy_broadcast_history.json");
  let broadcastHistory = loadBroadcastHistory(histPath);

  // Create workflow engine
  const engine = new WorkflowEngine({
    tools: toolMap,

    onStageStart: async (stage, ctx) => {
      // expose current stage to the learning wrapper
      learningCtx.getStage = () => stage.name;

      trace.emit({
        ts: Date.now(),
        type: "step.started",
        runId,
        stepId: stage.name,
        data: { stageType: stage.type },
      });
    },

    onStageEnd: async (stage, ctx, error) => {
      trace.emit({
        ts: Date.now(),
        type: "step.finished",
        runId,
        stepId: stage.name,
        data: error ? { error: error.message } : {},
      });
    },

    onActionStart: async (action, tool, params, ctx) => {
      trace.emit({
        ts: Date.now(),
        type: "tool.called",
        runId,
        stepId: ctx.__currentStage,
        tool: tool.name,
        data: { params },
      });
    },

    onActionEnd: async (action, tool, result, ctx) => {
      // Save artifacts for audit
      const artifactRefs: any[] = [];
      if (tool.name.includes("quote") || tool.name.includes("build") || tool.name.includes("balance")) {
        artifactRefs.push(trace.writeArtifact(runId, `${tool.name}_${Date.now()}`, result));
      }

      trace.emit({
        ts: Date.now(),
        type: "tool.result",
        runId,
        stepId: ctx.__currentStage,
        tool: tool.name,
        data: { ok: result?.ok },
        artifactRefs,
      });

      // Track broadcasts
      if (tool.meta.sideEffect === "broadcast" && result?.ok) {
        broadcastHistory.timestampsMs.push(Date.now());
        saveBroadcastHistory(histPath, broadcastHistory);

        trace.emit({
          ts: Date.now(),
          type: "tx.submitted",
          runId,
          chain: tool.meta.chain,
          data: { signature: result.signature, txHash: result.txHash },
        });
      }
    },

    onApprovalRequired: async (stage, ctx) => {
      if (opts.approve) {
        return opts.approve(`Approve stage '${stage.name}'?`);
      }
      return false;
    },

    onPolicyCheck: async (tool, params, ctx) => {
      const rpc = tool.meta.chain === "solana" ? resolveSolanaRpc(w3rtDir) : "";
      const network = tool.meta.chain === "solana" ? inferNetworkFromRpcUrl(rpc) : "mainnet";

      // Rate limiting context
      const now = Date.now();
      const last = broadcastHistory.timestampsMs.length
        ? broadcastHistory.timestampsMs[broadcastHistory.timestampsMs.length - 1]
        : undefined;
      const secondsSinceLastBroadcast = typeof last === "number" ? (now - last) / 1000 : undefined;
      const broadcastsLastMinute = broadcastHistory.timestampsMs.filter((ts) => now - ts < 60_000).length;

      // Extract program IDs for Solana
      let programIds: string[] | undefined;
      let programIdsKnown: boolean | undefined;
      if (tool.meta.chain === "solana" && typeof params.txB64 === "string") {
        const result = await extractSolanaProgramIds(params.txB64, resolveSolanaRpc(w3rtDir));
        programIds = result.ids;
        programIdsKnown = result.known;
      }

      // Build policy context
      const metricsSnap = loadMetricsSnapshot(w3rtDir);

      const policyCtx: PolicyContext = {
        chain: tool.meta.chain ?? "unknown",
        network,
        action: tool.meta.action,
        sideEffect: tool.meta.sideEffect,
        simulationOk: ctx.simulation?.ok === true,
        programIds,
        programIdsKnown,
        secondsSinceLastBroadcast,
        broadcastsLastMinute,
        metrics: metricsSnap.index,
      };

      // Add amount/slippage if available
      const quote = ctx.quote?.quoteResponse;
      if (quote) {
        if (typeof ctx.quote?.requestedSlippageBps === "number") {
          policyCtx.slippageBps = ctx.quote.requestedSlippageBps;
        }
        // Try to derive simulated slippage
        const expOut = Number(quote.outAmount);
        const simOut = Number(ctx.simulation?.simulatedOutAmount);
        if (Number.isFinite(expOut) && expOut > 0 && Number.isFinite(simOut) && simOut >= 0) {
          const slip = (expOut - simOut) / expOut;
          if (Number.isFinite(slip)) {
            policyCtx.simulatedSlippageBps = Math.max(0, Math.round(slip * 10_000));
          }
        }
      }

      const decision = policy.decide(policyCtx);

      trace.emit({
        ts: Date.now(),
        type: "policy.decision",
        runId,
        tool: tool.name,
        data: { ...decision, programIds },
      });

      if (decision.decision === "block") {
        return { allowed: false, reason: `${decision.code}: ${decision.message}` };
      }

      if (decision.decision === "confirm") {
        if (opts.approve) {
          const approved = await opts.approve(`Policy: ${decision.message}`);
          if (!approved) {
            return { allowed: false, reason: "User rejected policy confirmation" };
          }
        } else {
          return { allowed: false, reason: "Policy requires confirmation but no approver configured" };
        }
      }

      return { allowed: true };
    },
  });

  // Emit run started
  trace.emit({
    ts: Date.now(),
    type: "run.started",
    runId,
    data: { workflow: workflow.name, version: workflow.version },
  });

  // Run workflow
  const result = await engine.run(workflow, {
    __runId: runId,
    __w3rtDir: w3rtDir,
    __policy: policy,
    __approve: opts.approve,
  });

  // Emit run finished
  trace.emit({
    ts: Date.now(),
    type: "run.finished",
    runId,
    data: { ok: result.ok, error: result.error },
  });

  return { runId, ok: result.ok, error: result.error, context: result.context };
}
