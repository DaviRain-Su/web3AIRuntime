import { readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
function w3rtDir() {
    return process.env.W3RT_DIR || join(os.homedir(), ".w3rt");
}
function loadEvents(runId) {
    const p = join(w3rtDir(), "runs", runId, "trace.jsonl");
    const raw = readFileSync(p, "utf-8");
    return raw
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
}
export function policySuggestFromRun(runId) {
    const events = loadEvents(runId);
    // We emit policy.decision right before broadcast. If programIds were computed,
    // they'll be attached there.
    const dec = [...events].reverse().find((e) => e.type === "policy.decision" && e.tool === "solana_send_tx");
    const programIds = dec?.data?.programIds;
    if (!programIds || !programIds.length) {
        console.log("No programIds found in trace policy.decision.");
        console.log("Tip: run a swap once, then re-run this with that runId.");
        return;
    }
    console.log("allowlist:");
    console.log("  solanaPrograms:");
    for (const p of programIds.sort()) {
        console.log(`    - \"${p}\"`);
    }
}
//# sourceMappingURL=policy_cmd.js.map