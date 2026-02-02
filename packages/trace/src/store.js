import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import crypto from "node:crypto";
export class TraceStore {
    baseDir;
    constructor(baseDir) {
        this.baseDir = baseDir;
    }
    emit(e) {
        const full = { ...e, id: crypto.randomUUID() };
        const p = join(this.baseDir, "runs", full.runId, "trace.jsonl");
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify(full) + "\n", { flag: "a" });
        return full;
    }
}
//# sourceMappingURL=store.js.map