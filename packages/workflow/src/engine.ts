import type { Workflow, WorkflowStage, WorkflowAction } from "./types.js";

export type Dict = Record<string, any>;

export interface ToolDefinition {
  name: string;
  meta: {
    action: string;
    sideEffect: "none" | "broadcast";
    chain?: string;
    risk?: "low" | "medium" | "high";
  };
  execute: (params: Dict, ctx: Dict) => Promise<any>;
}

export interface WorkflowEngineConfig {
  tools: Map<string, ToolDefinition>;
  onStageStart?: (stage: WorkflowStage, ctx: Dict) => Promise<void>;
  onStageEnd?: (stage: WorkflowStage, ctx: Dict, error?: Error) => Promise<void>;
  onActionStart?: (action: WorkflowAction, tool: ToolDefinition, params: Dict, ctx: Dict) => Promise<void>;
  onActionEnd?: (action: WorkflowAction, tool: ToolDefinition, result: any, ctx: Dict) => Promise<void>;
  onApprovalRequired?: (stage: WorkflowStage, ctx: Dict) => Promise<boolean>;
  onPolicyCheck?: (tool: ToolDefinition, params: Dict, ctx: Dict) => Promise<{ allowed: boolean; reason?: string }>;
}

export interface RunResult {
  ok: boolean;
  runId: string;
  error?: string;
  context: Dict;
}

// Get value by dot-path from object
function getByPath(obj: any, path: string): any {
  const parts = path.split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// Render {{ expr }} templates in values
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

// Evaluate simple condition expressions
// Supports: path op value (op: ==, !=, >, >=, <, <=)
function evalCondition(expr: string, ctx: Dict): boolean {
  const m = expr.trim().match(/^([a-zA-Z0-9_\.]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
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
    case "!=":
      return left !== right;
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

export class WorkflowEngine {
  private config: WorkflowEngineConfig;

  constructor(config: WorkflowEngineConfig) {
    this.config = config;
  }

  async run(workflow: Workflow, initialCtx: Dict = {}): Promise<RunResult> {
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ctx: Dict = {
      ...initialCtx,
      __runId: runId,
      __workflow: workflow.name,
    };

    try {
      for (const stage of workflow.stages) {
        await this.runStage(stage, ctx);
      }

      return {
        ok: true,
        runId,
        context: ctx,
      };
    } catch (e: any) {
      return {
        ok: false,
        runId,
        error: e?.message ?? String(e),
        context: ctx,
      };
    }
  }

  private async runStage(stage: WorkflowStage, ctx: Dict): Promise<void> {
    // Check `when` condition
    if (stage.when) {
      const shouldRun = evalCondition(stage.when, ctx);
      if (!shouldRun) {
        return; // Skip stage
      }
    }

    // Notify stage start
    if (this.config.onStageStart) {
      await this.config.onStageStart(stage, ctx);
    }

    try {
      // Handle approval stage
      if (stage.type === "approval") {
        await this.handleApproval(stage, ctx);
        return;
      }

      // Run all actions in stage
      for (const action of stage.actions) {
        await this.runAction(action, stage, ctx);
      }

      // Notify stage end
      if (this.config.onStageEnd) {
        await this.config.onStageEnd(stage, ctx);
      }
    } catch (e) {
      if (this.config.onStageEnd) {
        await this.config.onStageEnd(stage, ctx, e as Error);
      }
      throw e;
    }
  }

  private async handleApproval(stage: WorkflowStage, ctx: Dict): Promise<void> {
    const required = stage.approval?.required ?? false;
    if (!required) return;

    // Check auto-approval conditions
    const conditions = stage.approval?.conditions ?? [];
    const allConditionsMet = conditions.every((c) => evalCondition(c, ctx));

    if (!allConditionsMet) {
      throw new Error(`Approval conditions failed for stage: ${stage.name}`);
    }

    // Request user approval
    if (this.config.onApprovalRequired) {
      const approved = await this.config.onApprovalRequired(stage, ctx);
      if (!approved) {
        throw new Error(`User rejected approval for stage: ${stage.name}`);
      }
    } else {
      // No approval handler - reject by default for safety
      throw new Error(`No approval handler configured for stage: ${stage.name}`);
    }
  }

  private async runAction(action: WorkflowAction, stage: WorkflowStage, ctx: Dict): Promise<void> {
    const tool = this.config.tools.get(action.tool);
    if (!tool) {
      throw new Error(`Unknown tool: ${action.tool}`);
    }

    // Render params with context
    const params = renderTemplate(action.params ?? {}, ctx);

    // Notify action start
    if (this.config.onActionStart) {
      await this.config.onActionStart(action, tool, params, ctx);
    }

    // Policy check for broadcast actions
    if (tool.meta.sideEffect === "broadcast" && this.config.onPolicyCheck) {
      const check = await this.config.onPolicyCheck(tool, params, ctx);
      if (!check.allowed) {
        throw new Error(`Policy blocked: ${check.reason ?? "unknown"}`);
      }
    }

    // Execute tool
    const result = await tool.execute(params, ctx);

    // Store result in context under the stage name
    ctx[stage.name] = result;

    // Also store under tool name for multi-action stages
    // Strip common prefixes for cleaner access
    const toolShortName = action.tool
      .replace(/^solana_/, "")
      .replace(/^jupiter_/, "")
      .replace(/_tx$/, "");
    ctx[toolShortName] = result;

    // Store common aliases for backward compatibility
    if (action.tool.includes("quote")) {
      ctx.quote = result;
    }
    if (action.tool.includes("build")) {
      ctx.built = result;
    }
    if (action.tool.includes("simulate")) {
      ctx.simulation = result;
    }
    if (action.tool.includes("send")) {
      ctx.submitted = result;
    }
    
    // Store under result key names if result has specific keys
    // This handles cases like calculate_opportunity returning { ok, profit, ... }
    if (result && typeof result === "object") {
      if ("profit" in result) ctx.opportunity = result;
      if ("prices" in result) ctx.prices = result;
    }

    // Notify action end
    if (this.config.onActionEnd) {
      await this.config.onActionEnd(action, tool, result, ctx);
    }
  }
}

// Helper to create tool map from array
export function createToolMap(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  return new Map(tools.map((t) => [t.name, t]));
}
