import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import crypto from "node:crypto";
import type { TraceEvent, ArtifactRef } from "./types.js";

export class TraceStore {
  constructor(private baseDir: string) {}

  runDir(runId: string) {
    return join(this.baseDir, "runs", runId);
  }

  artifactsDir(runId: string) {
    return join(this.runDir(runId), "artifacts");
  }

  writeArtifact(runId: string, name: string, obj: unknown): ArtifactRef {
    const dir = this.artifactsDir(runId);
    mkdirSync(dir, { recursive: true });

    const fileName = `${name}.json`;
    const path = join(dir, fileName);
    const data = JSON.stringify(obj, null, 2);
    writeFileSync(path, data, { flag: "w" });

    const sha256 = crypto.createHash("sha256").update(data).digest("hex");
    return { runId, name, path, sha256, bytes: Buffer.byteLength(data) };
  }

  emit(e: Omit<TraceEvent, "id">): TraceEvent {
    const full: TraceEvent = { ...e, id: crypto.randomUUID() };
    const p = join(this.baseDir, "runs", full.runId, "trace.jsonl");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(full) + "\n", { flag: "a" });
    return full;
  }
}
