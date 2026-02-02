import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";
import yaml from "js-yaml";

import { runWorkflowFromFile } from "@w3rt/runtime";

type Dict = Record<string, any>;

function w3rtDir() {
  return process.env.W3RT_DIR || join(os.homedir(), ".w3rt");
}

function uiPrint(ctx: any, text: string) {
  if (ctx?.ui?.print) return ctx.ui.print(text);
  // fallback
  console.log(text);
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

  // w3rt.run <workflowPath>
  pi.registerCommand("w3rt.run", {
    description: "Run a w3rt workflow (YAML)",
    execute: async (args: string[] = [], ctx: any) => {
      const workflowPath = args[0];
      if (!workflowPath) {
        ctx?.ui?.print?.("Usage: /w3rt.run <workflowPath>");
        return;
      }

      const approve = async (prompt: string) => {
        if (ctx?.ui?.confirm) return await ctx.ui.confirm("w3rt approval", prompt);
        return false;
      };

      uiPrint(ctx, `running workflow: ${workflowPath}`);

      const { runId, summary, ctx: runCtx } = await runWorkflowFromFile(workflowPath, { approve });

      uiPrint(ctx, `runId: ${runId}`);
      if (summary?.signature) uiPrint(ctx, `signature: ${summary.signature}`);
      if (summary?.explorerUrl) uiPrint(ctx, `explorer: ${summary.explorerUrl}`);

      // Best-effort human summary (Solana swap)
      const qr = runCtx?.quote?.quoteResponse;
      if (qr) {
        const inAmt = qr.inAmount ?? qr.amount;
        const outAmt = qr.outAmount;
        uiPrint(ctx, `quote: in=${inAmt ?? "?"} out=${outAmt ?? "?"} slippageBps=${qr.slippageBps ?? "?"}`);
      }
      const sim = runCtx?.simulation;
      if (sim) {
        uiPrint(ctx, `simulate: ${sim.ok ? "ok" : "failed"}${sim.unitsConsumed != null ? ` units=${sim.unitsConsumed}` : ""}`);
      }

      if (runCtx?.confirmed?.ok === true) {
        uiPrint(ctx, "confirm: ok");
      }
    },
  });

  // w3rt.trace <runId>
  pi.registerCommand("w3rt.trace", {
    description: "Show a w3rt run trace summary",
    execute: async (args: string[] = [], ctx: any) => {
      const runId = args[0];
      if (!runId) {
        uiPrint(ctx, "Usage: /w3rt.trace <runId>");
        return;
      }

      try {
        const events = loadTraceEvents(runId);
        const started = events.find((e) => e.type === "run.started");
        const finished = [...events].reverse().find((e) => e.type === "run.finished");

        uiPrint(ctx, `runId: ${runId}`);
        if (started?.data?.workflow) uiPrint(ctx, `workflow: ${started.data.workflow} v${started.data.version ?? ""}`);

        const solana = started?.data?.solana;
        if (solana?.network || solana?.rpcUrl || solana?.pubkey) {
          uiPrint(ctx, `solana: ${solana?.network ?? "?"}${solana?.pubkey ? ` | ${solana.pubkey}` : ""}`);
          if (solana?.rpcUrl) uiPrint(ctx, `rpc: ${solana.rpcUrl}`);
        }

        if (finished?.data) {
          uiPrint(ctx, `status: ${finished.data.ok ? "ok" : "failed"}${finished.data.error ? ` (${finished.data.error})` : ""}`);
        }

        const sigEv = [...events].reverse().find((e) => e.type === "tool.result" && e.tool === "solana_send_tx");
        const sig = sigEv?.data?.result?.signature;
        if (sig) uiPrint(ctx, `signature: ${sig}`);

        uiPrint(ctx, "steps:");
        for (const e of events) {
          if (e.type === "step.started") uiPrint(ctx, `- ${e.stepId} (start)`);
          if (e.type === "step.finished") uiPrint(ctx, `- ${e.stepId} (done)`);
        }

        // show errors when failed
        if (finished?.data?.ok === false) {
          const lastErr = [...events].reverse().find((e) => e.type === "tool.error");
          if (lastErr?.tool) {
            uiPrint(ctx, `lastErrorTool: ${lastErr.tool}`);
            if (lastErr?.data?.error) uiPrint(ctx, `lastError: ${lastErr.data.error}`);
          }
        }
      } catch (e: any) {
        uiPrint(ctx, String(e?.message ?? e));
      }
    },
  });

  // w3rt.replay <runId> [--workflow <path>] (dry validator)
  pi.registerCommand("w3rt.replay", {
    description: "Replay a run in dry mode (validator)",
    execute: async (args: string[] = [], ctx: any) => {
      const runId = args[0];
      if (!runId) {
        uiPrint(ctx, "Usage: /w3rt.replay <runId> [--workflow <path>]");
        return;
      }

      const wfIdx = args.findIndex((a) => a === "--workflow");
      const workflowPath = wfIdx !== -1 ? args[wfIdx + 1] : undefined;

      try {
        const events = loadTraceEvents(runId);
        const wfPath = workflowPath ? resolve(process.cwd(), workflowPath) : inferWorkflowPathFromRun(events);
        const wf = loadYamlFile<any>(wfPath);

        const ctxVars: Dict = {};
        const missing: Array<{ stepId: string; tool: string }> = [];

        uiPrint(ctx, `replay --dry runId: ${runId}`);
        uiPrint(ctx, `workflow: ${wf.name} v${wf.version}`);
        uiPrint(ctx, `workflowPath: ${wfPath}`);

        for (const stage of wf.stages ?? []) {
          if (stage.when) {
            const ok = evalWhen(stage.when, ctxVars);
            uiPrint(ctx, `- stage ${stage.name}: when (${stage.when}) => ${ok}`);
            if (!ok) continue;
          } else {
            uiPrint(ctx, `- stage ${stage.name}: when => true`);
          }

          if (stage.type === "approval" && stage.approval?.required) {
            uiPrint(ctx, `  - approval: required`);
            for (const c of stage.approval?.conditions ?? []) {
              const ok = evalWhen(c, ctxVars);
              uiPrint(ctx, `    - condition (${c}) => ${ok}`);
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
              uiPrint(ctx, `  - ${tool}: MISSING artifact`);
              continue;
            }
            const result = JSON.parse(readFileSync(artifactPath, "utf-8"));
            applyBindings(tool, result, ctxVars);
            uiPrint(ctx, `  - ${tool}: loaded artifact ${artifactPath}`);
          }
        }

        if (missing.length) {
          uiPrint(ctx, "missing artifacts:");
          for (const m of missing) uiPrint(ctx, `- step=${m.stepId} tool=${m.tool}`);
        }

        uiPrint(ctx, "replay --dry: OK");
      } catch (e: any) {
        uiPrint(ctx, String(e?.message ?? e));
      }
    },
  });

  // w3rt.policy.suggest <runId>
  pi.registerCommand("w3rt.policy.suggest", {
    description: "Suggest Solana allowlist programs from a run",
    execute: async (args: string[] = [], ctx: any) => {
      const runId = args[0];
      if (!runId) {
        uiPrint(ctx, "Usage: /w3rt.policy.suggest <runId>");
        return;
      }
      try {
        const events = loadTraceEvents(runId);
        const dec = [...events].reverse().find((e) => e.type === "policy.decision" && e.tool === "solana_send_tx");
        const programIds: string[] | undefined = dec?.data?.programIds;

        if (!programIds || !programIds.length) {
          uiPrint(ctx, "No programIds found in trace policy.decision.");
          return;
        }

        uiPrint(ctx, "allowlist:");
        uiPrint(ctx, "  solanaPrograms:");
        for (const p of programIds.sort()) uiPrint(ctx, `    - \"${p}\"`);
      } catch (e: any) {
        uiPrint(ctx, String(e?.message ?? e));
      }
    },
  });
}
