import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import yaml from "js-yaml";

import type { Workflow, WorkflowStage, WorkflowAction } from "@w3rt/workflow";
import { TraceStore } from "@w3rt/trace";
import { PolicyEngine, type PolicyConfig } from "@w3rt/policy";

import {
  Connection,
  Keypair,
  VersionedTransaction,
  clusterApiUrl,
  type Commitment,
} from "@solana/web3.js";

export interface RunOptions {
  w3rtDir?: string;
  approve?: (prompt: string) => Promise<boolean>;
}

type Dict = Record<string, any>;

type SolanaCluster = "mainnet-beta" | "testnet" | "devnet";

function getSolanaCluster(): SolanaCluster {
  return (process.env.W3RT_SOLANA_CLUSTER as SolanaCluster) || "devnet";
}

function solanaRpcUrl(cluster: SolanaCluster) {
  return process.env.W3RT_SOLANA_RPC_URL || clusterApiUrl(cluster);
}

function loadSolanaCliConfig(): { rpcUrl?: string; keypairPath?: string } {
  try {
    const p = join(os.homedir(), ".config", "solana", "cli", "config.yml");
    const cfg = loadYamlFile<any>(p);
    return { rpcUrl: cfg?.json_rpc_url, keypairPath: cfg?.keypair_path };
  } catch {
    return {};
  }
}

function loadSolanaKeypair(): Keypair | null {
  // Priority:
  // 1) W3RT_SOLANA_PRIVATE_KEY (JSON array)
  // 2) W3RT_SOLANA_KEYPAIR_PATH (file)
  // 3) Solana CLI config.yml -> keypair_path

  const raw = process.env.W3RT_SOLANA_PRIVATE_KEY;
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return Keypair.fromSecretKey(Uint8Array.from(arr));
    } catch {
      // fall through
    }
  }

  const kpPath = process.env.W3RT_SOLANA_KEYPAIR_PATH || loadSolanaCliConfig().keypairPath;
  if (kpPath) {
    try {
      const arr = JSON.parse(readFileSync(kpPath, "utf-8"));
      if (Array.isArray(arr)) return Keypair.fromSecretKey(Uint8Array.from(arr));
    } catch {
      // fall through
    }
  }

  return null;
}

function resolveSolanaRpc(): string {
  if (process.env.W3RT_SOLANA_RPC_URL) return process.env.W3RT_SOLANA_RPC_URL;

  // If user has Solana CLI configured, respect it.
  const cli = loadSolanaCliConfig();
  if (cli.rpcUrl) return cli.rpcUrl;

  return solanaRpcUrl(getSolanaCluster());
}

function defaultW3rtDir() {
  return join(os.homedir(), ".w3rt");
}

function loadYamlFile<T>(path: string): T {
  const raw = readFileSync(path, "utf-8");
  return yaml.load(raw) as T;
}

function getByPath(obj: any, path: string): any {
  const parts = path.split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function renderTemplate(value: any, ctx: Dict): any {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, expr) => {
      const v = getByPath(ctx, String(expr).trim());
      return v == null ? "" : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => renderTemplate(v, ctx));
  if (value && typeof value === "object") {
    const out: Dict = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderTemplate(v, ctx);
    return out;
  }
  return value;
}

// MVP: tiny expression evaluator supporting:
// - path op number/bool
// - op in: >, >=, <, <=, ==
function evalWhen(expr: string, ctx: Dict): boolean {
  const m = expr.trim().match(/^([a-zA-Z0-9_\.]+)\s*(==|>=|<=|>|<)\s*(.+)$/);
  if (!m) return false;
  const [, leftPath, op, rightRaw] = m;
  const left = getByPath(ctx, leftPath);

  let right: any = rightRaw.trim();
  if (right === "true") right = true;
  else if (right === "false") right = false;
  else if (!Number.isNaN(Number(right))) right = Number(right);
  else right = right.replace(/^['\"]|['\"]$/g, "");

  switch (op) {
    case "==":
      return left === right;
    case ">":
      return Number(left) > Number(right);
    case ">=":
      return Number(left) >= Number(right);
    case "<":
      return Number(left) < Number(right);
    case "<=":
      return Number(left) <= Number(right);
    default:
      return false;
  }
}

interface Tool {
  name: string;
  meta: { action: string; sideEffect: "none" | "broadcast"; chain?: string; risk?: "low" | "high" };
  execute: (params: Dict, ctx: Dict) => Promise<any>;
}

function createMockTools(): Tool[] {
  return [
    // ----- generic mock tools (used by mock-arb.yaml)
    {
      name: "price_check",
      meta: { action: "price_check", sideEffect: "none", risk: "low" },
      async execute(params) {
        const tokens = params.tokens ?? [];
        const chains = params.chains ?? [];
        return {
          tokens,
          chains,
          prices: {
            SUI: 1.2,
            USDC: 1.0,
          },
        };
      },
    },
    {
      name: "calculate_opportunity",
      meta: { action: "calc_opportunity", sideEffect: "none", risk: "low" },
      async execute(params) {
        const minProfit = Number(params.minProfit ?? 0);
        // mocked opportunity
        return {
          ok: true,
          profit: Math.max(minProfit + 5, 15),
          sourceChain: "sui",
          targetChain: "bnb",
          sourceToken: "SUI",
          targetToken: "USDC",
          amount: "100",
        };
      },
    },
    {
      name: "simulate_swap",
      meta: { action: "swap", sideEffect: "none", risk: "low" },
      async execute(params) {
        return {
          ok: true,
          chain: params.chain,
          from: params.from,
          to: params.to,
          amount: params.amount,
          profitUsd: 60,
        };
      },
    },
    {
      name: "swap",
      meta: { action: "swap", sideEffect: "broadcast", risk: "high" },
      async execute(params, ctx) {
        const profitUsd = Number(ctx?.simulation?.profitUsd ?? 0);
        return {
          ok: true,
          chain: params.chain,
          from: params.from,
          to: params.to,
          amount: params.amount,
          profitUsd,
          txHash: "mock_tx_" + crypto.randomBytes(4).toString("hex"),
        };
      },
    },
    {
      name: "verify_balance",
      meta: { action: "verify_balance", sideEffect: "none", risk: "low" },
      async execute() {
        return { ok: true };
      },
    },
    {
      name: "notify",
      meta: { action: "notify", sideEffect: "none", risk: "low" },
      async execute(params) {
        return { ok: true, message: params.message };
      },
    },

    // ----- solana/jupiter mock tools (used by solana_swap_exact_in.yaml)
    {
      name: "solana_jupiter_quote",
      meta: { action: "quote", sideEffect: "none", chain: "solana", risk: "low" },
      async execute(params, ctx) {
        // Real Jupiter quote (works for devnet too; route quality differs)
        const url = new URL("https://quote-api.jup.ag/v6/quote");
        url.searchParams.set("inputMint", String(params.inputMint));
        url.searchParams.set("outputMint", String(params.outputMint));
        url.searchParams.set("amount", String(params.amount));
        if (params.slippageBps != null) url.searchParams.set("slippageBps", String(params.slippageBps));

        const res = await fetch(url);
        if (!res.ok) throw new Error(`Jupiter quote failed: ${res.status} ${await res.text()}`);
        const quoteResponse = await res.json();

        const quoteId = "q_" + crypto.randomBytes(6).toString("hex");
        ctx.__jupQuotes = ctx.__jupQuotes || {};
        ctx.__jupQuotes[quoteId] = quoteResponse;

        return { ok: true, quoteId, quoteResponse };
      },
    },
    {
      name: "solana_jupiter_build_tx",
      meta: { action: "build_tx", sideEffect: "none", chain: "solana", risk: "low" },
      async execute(params, ctx) {
        const kp = loadSolanaKeypair();
        if (!kp) {
          throw new Error(
            "Missing W3RT_SOLANA_PRIVATE_KEY (JSON array). Needed to build a swap tx via Jupiter v6 /swap"
          );
        }

        const quote = ctx.__jupQuotes?.[String(params.quoteId)];
        if (!quote) throw new Error(`Unknown quoteId: ${params.quoteId}`);

        const body = {
          quoteResponse: quote,
          userPublicKey: kp.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
        };

        const res = await fetch("https://quote-api.jup.ag/v6/swap", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`Jupiter swap build failed: ${res.status} ${await res.text()}`);
        const out = await res.json();

        const txB64 = out.swapTransaction;
        if (!txB64) throw new Error("Jupiter response missing swapTransaction");

        return { ok: true, quoteId: params.quoteId, txB64 };
      },
    },
    {
      name: "solana_simulate_tx",
      meta: { action: "simulate", sideEffect: "none", chain: "solana", risk: "low" },
      async execute(params) {
        const rpc = resolveSolanaRpc();
        const conn = new Connection(rpc, { commitment: "processed" as Commitment });

        const raw = Buffer.from(String(params.txB64), "base64");
        const tx = VersionedTransaction.deserialize(raw);

        const sim = await conn.simulateTransaction(tx, {
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: "processed",
        });

        if (sim.value.err) {
          return { ok: false, err: sim.value.err, logs: sim.value.logs ?? [] };
        }

        return {
          ok: true,
          unitsConsumed: sim.value.unitsConsumed ?? null,
          logs: sim.value.logs ?? [],
        };
      },
    },
    {
      name: "solana_send_tx",
      meta: { action: "swap", sideEffect: "broadcast", chain: "solana", risk: "high" },
      async execute(params) {
        const kp = loadSolanaKeypair();
        if (!kp) {
          throw new Error(
            "Missing Solana keypair. Set W3RT_SOLANA_PRIVATE_KEY, or W3RT_SOLANA_KEYPAIR_PATH, or configure Solana CLI (solana config set --keypair ...)"
          );
        }

        const rpc = resolveSolanaRpc();
        const conn = new Connection(rpc, { commitment: "confirmed" as Commitment });

        const raw = Buffer.from(String(params.txB64), "base64");
        const tx = VersionedTransaction.deserialize(raw);
        tx.sign([kp]);

        const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
        return { ok: true, signature: sig };
      },
    },
    {
      name: "solana_confirm_tx",
      meta: { action: "confirm", sideEffect: "none", chain: "solana", risk: "low" },
      async execute(params) {
        const rpc = resolveSolanaRpc();
        const conn = new Connection(rpc, { commitment: "confirmed" as Commitment });

        const sig = String(params.signature);
        const latest = await conn.getLatestBlockhash("confirmed");
        const conf = await conn.confirmTransaction(
          {
            signature: sig,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          "confirmed"
        );

        if (conf.value.err) return { ok: false, signature: sig, err: conf.value.err };
        return { ok: true, signature: sig };
      },
    },
  ];
}

function toolMap(tools: Tool[]) {
  return new Map(tools.map((t) => [t.name, t] as const));
}

async function runStage(stage: WorkflowStage, tools: Map<string, Tool>, ctx: Dict, trace: TraceStore, runId: string) {
  if (stage.when) {
    const ok = evalWhen(stage.when, ctx);
    if (!ok) return;
  }

  const stepId = stage.name;
  trace.emit({ ts: Date.now(), type: "step.started", runId, stepId, data: { stageType: stage.type } });

  if (stage.type === "approval") {
    const required = stage.approval?.required ?? false;
    if (required) {
      const conditions = stage.approval?.conditions ?? [];
      const allOk = conditions.every((c: string) => evalWhen(c, ctx));
      if (!allOk) {
        trace.emit({ ts: Date.now(), type: "step.finished", runId, stepId, data: { approved: false, reason: "conditions_failed" } });
        throw new Error(`Approval conditions failed for stage ${stage.name}`);
      }

      const approveFn = ctx.__approve as RunOptions["approve"] | undefined;
      const prompt = `Approve stage '${stage.name}'?`;
      const approved = approveFn ? await approveFn(prompt) : false;
      trace.emit({ ts: Date.now(), type: "step.finished", runId, stepId, data: { approved } });
      if (!approved) throw new Error("User rejected approval");
      return;
    }
  }

  for (const action of stage.actions) {
    await runAction(action, tools, ctx, trace, runId, stepId);
  }

  trace.emit({ ts: Date.now(), type: "step.finished", runId, stepId });
}

async function runAction(action: WorkflowAction, tools: Map<string, Tool>, ctx: Dict, trace: TraceStore, runId: string, stepId: string) {
  const t = tools.get(action.tool);
  if (!t) throw new Error(`Unknown tool: ${action.tool}`);

  const params = renderTemplate(action.params ?? {}, ctx);
  trace.emit({ ts: Date.now(), type: "tool.called", runId, stepId, tool: t.name, data: { params } });

  // Policy gate: only for side-effect tools in MVP
  if (t.meta.sideEffect === "broadcast") {
    const engine = ctx.__policy as PolicyEngine | undefined;
    if (engine) {
      const decision = engine.decide({
        chain: t.meta.chain ?? "unknown",
        network: "mainnet",
        action: t.meta.action,
        amountUsd: ctx.opportunity?.profit ? Number(ctx.opportunity.profit) * 10 : undefined,
      });
      trace.emit({ ts: Date.now(), type: "policy.decision", runId, stepId, tool: t.name, data: decision as any });
      if (decision.decision === "block") throw new Error(`Policy blocked: ${decision.code}`);
      if (decision.decision === "confirm") {
        const approveFn = ctx.__approve as RunOptions["approve"] | undefined;
        const ok = approveFn ? await approveFn(`Policy confirm: ${decision.message}`) : false;
        if (!ok) throw new Error("Policy confirm rejected");
      }
    }
  }

  try {
    const result = await t.execute(params, ctx);
    trace.emit({ ts: Date.now(), type: "tool.result", runId, stepId, tool: t.name, data: { result } });

    // Convention: store key results for templating
    if (t.name === "calculate_opportunity") ctx.opportunity = result;
    if (t.name === "simulate_swap") ctx.simulation = result;
    if (t.name === "swap") ctx.result = { ...(ctx.result ?? {}), ...(result ?? {}) };

    // Solana swap workflow bindings
    if (t.name === "solana_jupiter_quote") ctx.quote = result;
    if (t.name === "solana_jupiter_build_tx") ctx.built = result;
    if (t.name === "solana_simulate_tx") ctx.simulation = result;
    if (t.name === "solana_send_tx") ctx.submitted = result;
    if (t.name === "solana_confirm_tx") ctx.confirmed = result;

    return result;
  } catch (err: any) {
    trace.emit({ ts: Date.now(), type: "tool.error", runId, stepId, tool: t.name, data: { error: String(err?.message ?? err) } });
    throw err;
  }
}

export async function runWorkflowFromFile(workflowPath: string, opts: RunOptions = {}) {
  const wf = loadYamlFile<Workflow>(workflowPath);

  const w3rtDir = opts.w3rtDir ?? defaultW3rtDir();
  mkdirSync(w3rtDir, { recursive: true });

  const runId = crypto.randomUUID();
  const trace = new TraceStore(w3rtDir);

  // policy config (optional)
  let policy: PolicyEngine | undefined;
  try {
    const policyCfg = loadYamlFile<PolicyConfig>(join(process.cwd(), ".w3rt", "policy.yaml"));
    policy = new PolicyEngine(policyCfg);
  } catch {
    // ok for now
  }

  const ctx: Dict = {
    __approve: opts.approve,
    __policy: policy,
  };

  trace.emit({ ts: Date.now(), type: "run.started", runId, data: { workflow: wf.name, version: wf.version } });

  const tools = toolMap(createMockTools());

  try {
    for (const stage of wf.stages) {
      await runStage(stage, tools, ctx, trace, runId);
    }
    trace.emit({ ts: Date.now(), type: "run.finished", runId, data: { ok: true } });
  } catch (err: any) {
    trace.emit({ ts: Date.now(), type: "run.finished", runId, data: { ok: false, error: String(err?.message ?? err) } });
    throw err;
  }

  return { runId, ctx };
}
