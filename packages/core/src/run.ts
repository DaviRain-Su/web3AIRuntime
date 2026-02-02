import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import yaml from "js-yaml";

import type { Workflow, WorkflowStage, WorkflowAction } from "@w3rt/workflow";
import { TraceStore } from "@w3rt/trace";
import { PolicyEngine, type PolicyConfig } from "@w3rt/policy";

export interface RunOptions {
  w3rtDir?: string;
  approve?: (prompt: string) => Promise<boolean>;
}

type Dict = Record<string, any>;

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
      async execute(params) {
        return {
          ok: true,
          quoteId: "q_" + crypto.randomBytes(4).toString("hex"),
          inputMint: params.inputMint,
          outputMint: params.outputMint,
          amount: params.amount,
          slippageBps: params.slippageBps,
          outAmount: "1999000",
        };
      },
    },
    {
      name: "solana_jupiter_build_tx",
      meta: { action: "build_tx", sideEffect: "none", chain: "solana", risk: "low" },
      async execute(params) {
        return {
          ok: true,
          quoteId: params.quoteId,
          txB64: Buffer.from("MOCK_SOLANA_TX").toString("base64"),
        };
      },
    },
    {
      name: "solana_simulate_tx",
      meta: { action: "simulate", sideEffect: "none", chain: "solana", risk: "low" },
      async execute(params) {
        return {
          ok: true,
          txB64: params.txB64,
          unitsConsumed: 123456,
        };
      },
    },
    {
      name: "solana_send_tx",
      meta: { action: "swap", sideEffect: "broadcast", chain: "solana", risk: "high" },
      async execute() {
        return {
          ok: true,
          signature: "mock_sig_" + crypto.randomBytes(8).toString("hex"),
        };
      },
    },
    {
      name: "solana_confirm_tx",
      meta: { action: "confirm", sideEffect: "none", chain: "solana", risk: "low" },
      async execute(params) {
        return {
          ok: true,
          signature: params.signature,
          slot: 999,
        };
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
