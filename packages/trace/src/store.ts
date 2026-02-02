import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import crypto from "node:crypto";
import type { TraceEvent } from "./types.js";

export class TraceStore {
  constructor(private baseDir: string) {}

  emit(e: Omit<TraceEvent, "id">): TraceEvent {
    const full: TraceEvent = { ...e, id: crypto.randomUUID() };
    const p = join(this.baseDir, "runs", full.runId, "trace.jsonl");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(full) + "\n", { flag: "a" });
    return full;
  }
}
