import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";
import yaml from "js-yaml";

import { runWorkflowFromFile } from "@w3rt/runtime";

type Dict = Record<string, any>;

function w3rtDir() {
  return process.env.W3RT_DIR || join(os.homedir(), ".w3rt");
}

function w3rtTmpDir() {
  const d = join(w3rtDir(), "tmp");
  mkdirSync(d, { recursive: true });
  return d;
}

const SOL_MINT = "So11111111111111111111111111111111111111112"; // wrapped SOL
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

function parseSwapIntent(text: string): {
  ok: boolean;
  error?: string;
  amountSol?: number;
  output?: "USDC" | "USDT";
  slippageBps?: number;
} {
  const t = text.trim();

  // slippage: "滑点 0.5%" or "slippage 0.5%" or "slippage=50bps"
  let slippageBps: number | undefined;
  const mSlipPct = t.match(/(?:滑点|slippage)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*%/i);
  if (mSlipPct) {
    slippageBps = Math.round(Number(mSlipPct[1]) * 100);
  }
  const mSlipBps = t.match(/(?:滑点|slippage)\s*[:=]?\s*(\d+)\s*bps/i);
  if (mSlipBps) {
    slippageBps = Number(mSlipBps[1]);
  }

  // output token aliases
  const upper = t.toUpperCase();
  let output: "USDC" | "USDT" = "USDC"; // default: U -> USDC
  if (/(USDT|\bTETHER\b|泰达)/i.test(t)) output = "USDT";
  else if (/(USDC|\bUSD\s*COIN\b)/i.test(t)) output = "USDC";
  else if (/(\bU\b|\bU币\b|\bU幣\b)/i.test(t)) output = "USDC";

  // amount (first number)
  const mAmt = t.match(/(\d+(?:\.\d+)?)/);
  if (!mAmt) return { ok: false, error: "Missing amount (e.g. 0.01 SOL)" };
  const amount = Number(mAmt[1]);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Invalid amount" };

  // For MVP: assume input is SOL when user mentions SOL/sol/索拉纳
  if (!/(\bSOL\b|索拉纳|索拉納)/i.test(t)) {
    return { ok: false, error: "MVP only supports SOL -> USDC/USDT (please include 'SOL' in request)" };
  }

  return { ok: true, amountSol: amount, output, slippageBps };
}

function buildSolanaSwapWorkflow(params: {
  amountSol: number;
  outputMint: string;
  slippageBps: number;
}) {
  const amountLamports = String(Math.round(params.amountSol * 1_000_000_000));

  // Load template from repo workflows
  const templatePath = resolve(process.cwd(), "workflows", "solana_swap_exact_in.yaml");
  const wf = loadYamlFile<any>(templatePath);

  // Patch quote stage params
  const quote = wf?.stages?.find((s: any) => s?.name === "quote");
  const act = quote?.actions?.find((a: any) => a?.tool === "solana_jupiter_quote");
  if (!act) throw new Error("Template workflow missing solana_jupiter_quote action");

  act.params = {
    inputMint: SOL_MINT,
    outputMint: params.outputMint,
    amount: amountLamports,
    slippageBps: params.slippageBps,
  };

  return wf;
}

function loadTraceEvents(runId: string) {
  const p = join(w3rtDir(), "runs", runId, "trace.jsonl");
  if (!existsSync(p)) throw new Error(`No trace found for runId ${runId}. Expected: ${p}`);
  const raw = readFileSync(p, "utf-8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
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

function loadYamlFile<T>(path: string): T {
  const raw = readFileSync(path, "utf-8");
  return yaml.load(raw) as T;
}

function inferWorkflowPathFromRun(events: any[]): string {
  const started = events.find((e) => e.type === "run.started");
  const name = started?.data?.workflow;
  if (!name) throw new Error("Missing workflow name in run.started");

  const yml = resolve(process.cwd(), "workflows", `${name}.yml`);
  const yamlPath = resolve(process.cwd(), "workflows", `${name}.yaml`);
  if (existsSync(yamlPath)) return yamlPath;
  if (existsSync(yml)) return yml;
  throw new Error(`Cannot find workflow file for '${name}'. Expected ${yamlPath}`);
}

function applyBindings(tool: string, result: any, ctx: Dict) {
  if (tool === "solana_jupiter_quote") ctx.quote = result;
  if (tool === "solana_jupiter_build_tx") ctx.built = result;
  if (tool === "solana_simulate_tx") ctx.simulation = result;
  if (tool === "solana_send_tx") ctx.submitted = result;
  if (tool === "solana_confirm_tx") ctx.confirmed = result;
}

function findArtifact(events: any[], tool: string, stepId: string): string | null {
  const ev = events.find((e) => e.type === "tool.result" && e.tool === tool && e.stepId === stepId);
  const ref = ev?.artifactRefs?.[0];
  if (ref?.path) return ref.path;

  const base = join(w3rtDir(), "runs", events[0]?.runId ?? "", "artifacts");
  const prefixes: Record<string, string> = {
    solana_jupiter_quote: `quote_${stepId}`,
    solana_jupiter_build_tx: `built_${stepId}`,
    solana_simulate_tx: `simulation_${stepId}`,
    solana_send_tx: `submitted_${stepId}`,
    solana_confirm_tx: `confirmed_${stepId}`,
  };
  const n = prefixes[tool];
  if (!n) return null;
  const p = join(base, `${n}.json`);
  return existsSync(p) ? p : null;
}

// Pi SDK types are intentionally loose for now (we'll tighten after we pin Pi APIs).
export default function w3rtPiExtension(pi: any) {
  if (typeof pi?.registerCommand !== "function") return;

  // Future: hook into Pi tool events so policy/trace apply to any Pi tool calls.
  // (Our current workflow runner uses internal tools, so this is just scaffolding.)
  if (typeof pi?.on === "function") {
    pi.on("tool_call", async (_event: any, _ctx: any) => {
      // TODO: policy gate for Pi-registered web3 tools
    });
    pi.on("tool_result", async (_event: any, _ctx: any) => {
      // TODO: trace events for Pi-registered web3 tools
    });
  }

  // w3rt <natural language>
  // Examples:
  // - 换 0.01 SOL 到 U，滑点 0.5%
  // - swap 0.01 SOL to USDC with slippage 0.5%
  pi.registerCommand("w3rt", {
    description: "Natural language web3 actions (MVP: SOL->USDC/USDT swap)",
    handler: async (args: string, ctx: any) => {
      const text = (args ?? "").trim();
      if (!text) {
        ctx?.ui?.notify?.("Usage: /w3rt <text>", "error");
        return;
      }

      const intent = parseSwapIntent(text);
      if (!intent.ok) {
        ctx?.ui?.notify?.(intent.error ?? "Unable to parse intent", "error");
        return;
      }

      const slippageBps = intent.slippageBps ?? 50;
      const outputMint = intent.output === "USDT" ? USDT_MINT : USDC_MINT;

      // Show plan
      ctx?.ui?.notify?.(
        `plan: swap ${intent.amountSol} SOL -> ${intent.output} (slippage ${(slippageBps / 100).toFixed(2)}%)`,
        "info"
      );

      const ok = ctx?.ui?.confirm
        ? await ctx.ui.confirm("w3rt approval", "Proceed to simulate and execute?")
        : false;
      if (!ok) {
        ctx?.ui?.notify?.("cancelled", "warning");
        return;
      }

      // Generate a temp workflow and run it
      const wf = buildSolanaSwapWorkflow({
        amountSol: intent.amountSol!,
        outputMint,
        slippageBps,
      });

      const tmpPath = join(w3rtTmpDir(), `w3rt_${Date.now()}.yaml`);
      writeFileSync(tmpPath, yaml.dump(wf), "utf-8");

      const approve = async (prompt: string) => {
        if (ctx?.ui?.confirm) return await ctx.ui.confirm("w3rt approval", prompt);
        return false;
      };

      const { runId, summary, ctx: runCtx } = await runWorkflowFromFile(tmpPath, { approve });

      ctx?.ui?.notify?.(`runId: ${runId}`, "info");
      if (summary?.signature) ctx?.ui?.notify?.(`signature: ${summary.signature}`, "info");
      if (summary?.explorerUrl) ctx?.ui?.notify?.(`explorer: ${summary.explorerUrl}`, "info");

      const qr = runCtx?.quote?.quoteResponse;
      if (qr) {
        const inAmt = qr.inAmount ?? qr.amount;
        const outAmt = qr.outAmount;
        ctx?.ui?.notify?.(`quote: in=${inAmt ?? "?"} out=${outAmt ?? "?"} slippageBps=${qr.slippageBps ?? "?"}`, "info");
      }
      const sim = runCtx?.simulation;
      if (sim) {
        ctx?.ui?.notify?.(`simulate: ${sim.ok ? "ok" : "failed"}${sim.unitsConsumed != null ? ` units=${sim.unitsConsumed}` : ""}`, "info");
      }
      if (runCtx?.confirmed?.ok === true) {
        ctx?.ui?.notify?.("confirm: ok", "success");
      }
    },
  });

  // w3rt.run <workflowPath>
  pi.registerCommand("w3rt.run", {
    description: "Run a w3rt workflow (YAML)",
    handler: async (args: string, ctx: any) => {
      const workflowPath = args?.trim();
      if (!workflowPath) {
        ctx?.ui?.notify?.("Usage: /w3rt.run <workflowPath>", "error");
        return;
      }

      const approve = async (prompt: string) => {
        if (ctx?.ui?.confirm) return await ctx.ui.confirm("w3rt approval", prompt);
        return false;
      };

      ctx?.ui?.notify?.(`running workflow: ${workflowPath}`, "info");

      const { runId, summary, ctx: runCtx } = await runWorkflowFromFile(workflowPath, { approve });

      ctx?.ui?.notify?.(`runId: ${runId}`, "info");
      if (summary?.signature) ctx?.ui?.notify?.(`signature: ${summary.signature}`, "info");
      if (summary?.explorerUrl) ctx?.ui?.notify?.(`explorer: ${summary.explorerUrl}`, "info");

      // Best-effort human summary (Solana swap)
      const qr = runCtx?.quote?.quoteResponse;
      if (qr) {
        const inAmt = qr.inAmount ?? qr.amount;
        const outAmt = qr.outAmount;
        ctx?.ui?.notify?.(`quote: in=${inAmt ?? "?"} out=${outAmt ?? "?"} slippageBps=${qr.slippageBps ?? "?"}`, "info");
      }
      const sim = runCtx?.simulation;
      if (sim) {
        ctx?.ui?.notify?.(`simulate: ${sim.ok ? "ok" : "failed"}${sim.unitsConsumed != null ? ` units=${sim.unitsConsumed}` : ""}`, "info");
      }

      if (runCtx?.confirmed?.ok === true) {
        ctx?.ui?.notify?.("confirm: ok", "success");
      }
    },
  });

  // w3rt.trace <runId>
  pi.registerCommand("w3rt.trace", {
    description: "Show a w3rt run trace summary",
    handler: async (args: string, ctx: any) => {
      const runId = args?.trim();
      if (!runId) {
        ctx?.ui?.notify?.("Usage: /w3rt.trace <runId>", "error");
        return;
      }

      try {
        const events = loadTraceEvents(runId);
        const started = events.find((e) => e.type === "run.started");
        const finished = [...events].reverse().find((e) => e.type === "run.finished");

        ctx?.ui?.notify?.(`runId: ${runId}`, "info");
        if (started?.data?.workflow) ctx?.ui?.notify?.(`workflow: ${started.data.workflow} v${started.data.version ?? ""}`, "info");

        const solana = started?.data?.solana;
        if (solana?.network || solana?.rpcUrl || solana?.pubkey) {
          ctx?.ui?.notify?.(`solana: ${solana?.network ?? "?"}${solana?.pubkey ? ` | ${solana.pubkey}` : ""}`, "info");
          if (solana?.rpcUrl) ctx?.ui?.notify?.(`rpc: ${solana.rpcUrl}`, "info");
        }

        if (finished?.data) {
          ctx?.ui?.notify?.(`status: ${finished.data.ok ? "ok" : "failed"}${finished.data.error ? ` (${finished.data.error})` : ""}`, "info");
        }

        const sigEv = [...events].reverse().find((e) => e.type === "tool.result" && e.tool === "solana_send_tx");
        const sig = sigEv?.data?.result?.signature;
        if (sig) ctx?.ui?.notify?.(`signature: ${sig}`, "info");

        ctx?.ui?.notify?.("steps:", "info");
        for (const e of events) {
          if (e.type === "step.started") ctx?.ui?.notify?.(`- ${e.stepId} (start)`, "info");
          if (e.type === "step.finished") ctx?.ui?.notify?.(`- ${e.stepId} (done)`, "info");
        }

        // show errors when failed
        if (finished?.data?.ok === false) {
          const lastErr = [...events].reverse().find((e) => e.type === "tool.error");
          if (lastErr?.tool) {
            ctx?.ui?.notify?.(`lastErrorTool: ${lastErr.tool}`, "error");
            if (lastErr?.data?.error) ctx?.ui?.notify?.(`lastError: ${lastErr.data.error}`, "error");
          }
        }
      } catch (e: any) {
        ctx?.ui?.notify?.(String(e?.message ?? e), "error");
      }
    },
  });

  // w3rt.replay <runId> [--workflow <path>] (dry validator)
  pi.registerCommand("w3rt.replay", {
    description: "Replay a run in dry mode (validator)",
    handler: async (args: string, ctx: any) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const runId = parts[0];
      if (!runId) {
        ctx?.ui?.notify?.("Usage: /w3rt.replay <runId> [--workflow <path>]", "error");
        return;
      }

      const wfIdx = parts.findIndex((a) => a === "--workflow");
      const workflowPath = wfIdx !== -1 ? parts[wfIdx + 1] : undefined;

      try {
        const events = loadTraceEvents(runId);
        const wfPath = workflowPath ? resolve(process.cwd(), workflowPath) : inferWorkflowPathFromRun(events);
        const wf = loadYamlFile<any>(wfPath);

        const ctxVars: Dict = {};
        const missing: Array<{ stepId: string; tool: string }> = [];

        ctx?.ui?.notify?.(`replay --dry runId: ${runId}`, "info");
        ctx?.ui?.notify?.(`workflow: ${wf.name} v${wf.version}`, "info");
        ctx?.ui?.notify?.(`workflowPath: ${wfPath}`, "info");

        for (const stage of wf.stages ?? []) {
          if (stage.when) {
            const ok = evalWhen(stage.when, ctxVars);
            ctx?.ui?.notify?.(`- stage ${stage.name}: when (${stage.when}) => ${ok}`, "info");
            if (!ok) continue;
          } else {
            ctx?.ui?.notify?.(`- stage ${stage.name}: when => true`, "info");
          }

          if (stage.type === "approval" && stage.approval?.required) {
            ctx?.ui?.notify?.(`  - approval: required`, "info");
            for (const c of stage.approval?.conditions ?? []) {
              const ok = evalWhen(c, ctxVars);
              ctx?.ui?.notify?.(`    - condition (${c}) => ${ok}`, "info");
            }
            const allOk = (stage.approval?.conditions ?? []).every((c: string) => evalWhen(c, ctxVars));
            if (!allOk) throw new Error(`Approval conditions failed for stage ${stage.name}`);
            continue;
          }

          for (const action of stage.actions ?? []) {
            const stepId = stage.name;
            const tool = action.tool;
            const artifactPath = findArtifact(events, tool, stepId);
            if (!artifactPath) {
              missing.push({ stepId, tool });
              ctx?.ui?.notify?.(`  - ${tool}: MISSING artifact`, "warning");
              continue;
            }
            const result = JSON.parse(readFileSync(artifactPath, "utf-8"));
            applyBindings(tool, result, ctxVars);
            ctx?.ui?.notify?.(`  - ${tool}: loaded artifact ${artifactPath}`, "info");
          }
        }

        if (missing.length) {
          ctx?.ui?.notify?.("missing artifacts:", "warning");
          for (const m of missing) ctx?.ui?.notify?.(`- step=${m.stepId} tool=${m.tool}`, "warning");
        }

        ctx?.ui?.notify?.("replay --dry: OK", "success");
      } catch (e: any) {
        ctx?.ui?.notify?.(String(e?.message ?? e), "error");
      }
    },
  });

  // w3rt.policy.suggest <runId>
  pi.registerCommand("w3rt.policy.suggest", {
    description: "Suggest Solana allowlist programs from a run",
    handler: async (args: string, ctx: any) => {
      const runId = args?.trim();
      if (!runId) {
        ctx?.ui?.notify?.("Usage: /w3rt.policy.suggest <runId>", "error");
        return;
      }
      try {
        const events = loadTraceEvents(runId);
        const dec = [...events].reverse().find((e) => e.type === "policy.decision" && e.tool === "solana_send_tx");
        const programIds: string[] | undefined = dec?.data?.programIds;

        if (!programIds || !programIds.length) {
          ctx?.ui?.notify?.("No programIds found in trace policy.decision.", "warning");
          return;
        }

        ctx?.ui?.notify?.("allowlist:", "info");
        ctx?.ui?.notify?.("  solanaPrograms:", "info");
        for (const p of programIds.sort()) ctx?.ui?.notify?.(`    - \"${p}\"`, "info");
      } catch (e: any) {
        ctx?.ui?.notify?.(String(e?.message ?? e), "error");
      }
    },
  });
}
