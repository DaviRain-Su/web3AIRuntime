import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import type { Workflow, WorkflowStage, WorkflowAction } from "./types.js";

export interface ParseResult {
  ok: boolean;
  workflow?: Workflow;
  errors?: string[];
}

export function parseWorkflow(content: string): ParseResult {
  const errors: string[] = [];

  let raw: any;
  try {
    raw = yaml.load(content);
  } catch (e: any) {
    return { ok: false, errors: [`YAML parse error: ${e?.message ?? e}`] };
  }

  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["Invalid workflow: must be an object"] };
  }

  // Validate required fields
  if (!raw.name || typeof raw.name !== "string") {
    errors.push("Missing or invalid 'name' field");
  }

  if (!raw.version || typeof raw.version !== "string") {
    errors.push("Missing or invalid 'version' field");
  }

  if (!raw.trigger || !["manual", "cron"].includes(raw.trigger)) {
    errors.push("Missing or invalid 'trigger' field (must be 'manual' or 'cron')");
  }

  if (!Array.isArray(raw.stages) || raw.stages.length === 0) {
    errors.push("Missing or empty 'stages' array");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Parse stages
  const stages: WorkflowStage[] = [];
  for (let i = 0; i < raw.stages.length; i++) {
    const s = raw.stages[i];
    const stageErrors = validateStage(s, i);
    if (stageErrors.length > 0) {
      errors.push(...stageErrors);
      continue;
    }

    stages.push({
      name: s.name,
      type: s.type,
      actions: (s.actions || []).map((a: any) => ({
        tool: a.tool,
        params: a.params,
      })),
      when: s.when,
      approval: s.approval,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const workflow: Workflow = {
    name: raw.name,
    version: raw.version,
    description: raw.description,
    trigger: raw.trigger,
    triggerConfig: raw.triggerConfig,
    stages,
    config: raw.config,
  };

  return { ok: true, workflow };
}

function validateStage(s: any, index: number): string[] {
  const errors: string[] = [];
  const prefix = `stages[${index}]`;

  if (!s || typeof s !== "object") {
    return [`${prefix}: must be an object`];
  }

  if (!s.name || typeof s.name !== "string") {
    errors.push(`${prefix}: missing or invalid 'name'`);
  }

  const validTypes = ["analysis", "simulation", "approval", "execution", "monitor"];
  if (!s.type || !validTypes.includes(s.type)) {
    errors.push(`${prefix}: invalid 'type' (must be one of: ${validTypes.join(", ")})`);
  }

  // Approval stage doesn't require actions
  if (s.type !== "approval") {
    if (!Array.isArray(s.actions) || s.actions.length === 0) {
      errors.push(`${prefix}: missing or empty 'actions'`);
    } else {
      for (let j = 0; j < s.actions.length; j++) {
        const a = s.actions[j];
        if (!a?.tool || typeof a.tool !== "string") {
          errors.push(`${prefix}.actions[${j}]: missing or invalid 'tool'`);
        }
      }
    }
  }

  // Validate approval config if present
  if (s.type === "approval" && s.approval) {
    if (typeof s.approval.required !== "boolean") {
      errors.push(`${prefix}.approval: 'required' must be a boolean`);
    }
    if (s.approval.conditions && !Array.isArray(s.approval.conditions)) {
      errors.push(`${prefix}.approval: 'conditions' must be an array`);
    }
  }

  return errors;
}

export function parseWorkflowFile(path: string): ParseResult {
  try {
    const content = readFileSync(path, "utf-8");
    return parseWorkflow(content);
  } catch (e: any) {
    return { ok: false, errors: [`Failed to read file: ${e?.message ?? e}`] };
  }
}
