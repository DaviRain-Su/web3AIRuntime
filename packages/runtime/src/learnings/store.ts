import { mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type LearningEvent = {
  ts: string;
  runId?: string;
  stage?: string;
  tool: string;
  action?: string;
  chain?: string;
  ok: boolean;
  error_code?: string;
  error_message?: string;
  params?: any;
  result?: any;
  applied_fix?: string;
};

export type LearningRule = {
  id: string;
  enabled?: boolean;
  match: {
    tool?: string;
    action?: string;
    chain?: string;
    error_code?: string;
    message_includes?: string;
  };
  effect: {
    // currently only supports tagging the event; in the future we can auto-patch params or trigger fallbacks.
    applied_fix: string;
  };
};

export type LearningStore = {
  dir: string;
  eventsPath: string;
  rulesPath: string;
};

export function getLearningStore(w3rtDir: string): LearningStore {
  const dir = join(w3rtDir, "learnings");
  return {
    dir,
    eventsPath: join(dir, "events.jsonl"),
    rulesPath: join(dir, "rules.json"),
  };
}

export function loadLearningRules(store: LearningStore): LearningRule[] {
  try {
    const raw = readFileSync(store.rulesPath, "utf-8");
    const j = JSON.parse(raw);
    return Array.isArray(j) ? (j as LearningRule[]) : [];
  } catch {
    return [];
  }
}

export function ensureLearningStore(store: LearningStore) {
  mkdirSync(store.dir, { recursive: true });
  // Create empty rules file if missing (helps discoverability)
  try {
    readFileSync(store.rulesPath, "utf-8");
  } catch {
    try {
      writeFileSync(store.rulesPath, JSON.stringify([], null, 2));
    } catch {}
  }
}

export function appendLearningEvent(store: LearningStore, ev: LearningEvent) {
  try {
    mkdirSync(dirname(store.eventsPath), { recursive: true });
    appendFileSync(store.eventsPath, JSON.stringify(ev) + "\n");
  } catch {
    // best-effort
  }
}

export function matchRule(rules: LearningRule[], ev: Partial<LearningEvent>): LearningRule | null {
  for (const r of rules) {
    if (r.enabled === false) continue;
    const m = r.match || ({} as any);
    if (m.tool && m.tool !== ev.tool) continue;
    if (m.action && m.action !== ev.action) continue;
    if (m.chain && m.chain !== ev.chain) continue;
    if (m.error_code && m.error_code !== ev.error_code) continue;
    if (m.message_includes && !(ev.error_message || "").includes(m.message_includes)) continue;
    return r;
  }
  return null;
}
