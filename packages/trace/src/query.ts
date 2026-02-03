import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TraceEvent, TraceEventType, ArtifactRef } from "./types.js";

export interface TraceFilter {
  runId?: string;
  types?: TraceEventType[];
  chain?: string;
  tool?: string;
  fromTs?: number;
  toTs?: number;
  limit?: number;
}

export interface TraceRun {
  runId: string;
  startedAt: number;
  finishedAt?: number;
  ok?: boolean;
  events: TraceEvent[];
  artifacts: ArtifactRef[];
}

export interface AuditReport {
  generatedAt: number;
  fromTs: number;
  toTs: number;
  summary: {
    totalRuns: number;
    successfulRuns: number;
    failedRuns: number;
    totalTransactions: number;
    chains: string[];
  };
  runs: Array<{
    runId: string;
    startedAt: number;
    finishedAt?: number;
    ok: boolean;
    transactions: Array<{
      txHash?: string;
      chain?: string;
      action?: string;
      status: "submitted" | "confirmed" | "failed";
    }>;
  }>;
}

export class TraceQuery {
  constructor(private baseDir: string) {}

  // List all run IDs
  listRuns(): string[] {
    const runsDir = join(this.baseDir, "runs");
    if (!existsSync(runsDir)) return [];

    try {
      return readdirSync(runsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse(); // Most recent first
    } catch {
      return [];
    }
  }

  // Load events from a run's trace.jsonl
  loadRunEvents(runId: string): TraceEvent[] {
    const tracePath = join(this.baseDir, "runs", runId, "trace.jsonl");
    if (!existsSync(tracePath)) return [];

    try {
      const content = readFileSync(tracePath, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      return lines.map((line) => JSON.parse(line) as TraceEvent);
    } catch {
      return [];
    }
  }

  // Load artifacts refs from a run
  loadRunArtifacts(runId: string): ArtifactRef[] {
    const artifactsDir = join(this.baseDir, "runs", runId, "artifacts");
    if (!existsSync(artifactsDir)) return [];

    try {
      const files = readdirSync(artifactsDir);
      return files
        .filter((f) => f.endsWith(".json"))
        .map((f) => ({
          runId,
          name: f.replace(".json", ""),
          path: join(artifactsDir, f),
        }));
    } catch {
      return [];
    }
  }

  // Get complete run info
  getRun(runId: string): TraceRun | null {
    const events = this.loadRunEvents(runId);
    if (events.length === 0) return null;

    const artifacts = this.loadRunArtifacts(runId);
    const startEvent = events.find((e) => e.type === "run.started");
    const finishEvent = events.find((e) => e.type === "run.finished");

    return {
      runId,
      startedAt: startEvent?.ts ?? events[0]?.ts ?? 0,
      finishedAt: finishEvent?.ts,
      ok: (finishEvent?.data as any)?.ok,
      events,
      artifacts,
    };
  }

  // Query events across all runs with filter
  queryEvents(filter: TraceFilter): TraceEvent[] {
    const results: TraceEvent[] = [];
    const runIds = filter.runId ? [filter.runId] : this.listRuns();

    for (const runId of runIds) {
      const events = this.loadRunEvents(runId);

      for (const e of events) {
        // Apply filters
        if (filter.types && !filter.types.includes(e.type)) continue;
        if (filter.chain && e.chain !== filter.chain) continue;
        if (filter.tool && e.tool !== filter.tool) continue;
        if (filter.fromTs && e.ts < filter.fromTs) continue;
        if (filter.toTs && e.ts > filter.toTs) continue;

        results.push(e);

        if (filter.limit && results.length >= filter.limit) {
          return results;
        }
      }
    }

    return results;
  }

  // Generate audit report for date range
  generateAuditReport(fromTs: number, toTs: number): AuditReport {
    const runIds = this.listRuns();
    const runs: AuditReport["runs"] = [];
    const chains = new Set<string>();
    let totalTransactions = 0;

    for (const runId of runIds) {
      const events = this.loadRunEvents(runId);
      if (events.length === 0) continue;

      const startEvent = events.find((e) => e.type === "run.started");
      const finishEvent = events.find((e) => e.type === "run.finished");
      const startTs = startEvent?.ts ?? events[0]?.ts ?? 0;

      // Filter by date range
      if (startTs < fromTs || startTs > toTs) continue;

      // Extract transactions
      const transactions: AuditReport["runs"][0]["transactions"] = [];

      const submittedEvents = events.filter((e) => e.type === "tx.submitted");
      const confirmedEvents = events.filter((e) => e.type === "tx.confirmed");

      for (const sub of submittedEvents) {
        const txHash = (sub.data as any)?.signature || (sub.data as any)?.txHash;
        const chain = sub.chain;
        const action = sub.data?.action as string | undefined;

        if (chain) chains.add(chain);

        const confirmed = confirmedEvents.find(
          (c) => (c.data as any)?.signature === txHash || (c.data as any)?.txHash === txHash
        );

        transactions.push({
          txHash,
          chain,
          action,
          status: confirmed ? "confirmed" : "submitted",
        });

        totalTransactions++;
      }

      runs.push({
        runId,
        startedAt: startTs,
        finishedAt: finishEvent?.ts,
        ok: (finishEvent?.data as any)?.ok ?? false,
        transactions,
      });
    }

    const successfulRuns = runs.filter((r) => r.ok).length;

    return {
      generatedAt: Date.now(),
      fromTs,
      toTs,
      summary: {
        totalRuns: runs.length,
        successfulRuns,
        failedRuns: runs.length - successfulRuns,
        totalTransactions,
        chains: [...chains],
      },
      runs,
    };
  }

  // Load artifact content
  loadArtifact(runId: string, name: string): any {
    const path = join(this.baseDir, "runs", runId, "artifacts", `${name}.json`);
    if (!existsSync(path)) return null;

    try {
      const content = readFileSync(path, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
}
