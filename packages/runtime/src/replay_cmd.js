import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";
import yaml from "js-yaml";
function w3rtDir() {
    return process.env.W3RT_DIR || join(os.homedir(), ".w3rt");
}
function loadYamlFile(path) {
    const raw = readFileSync(path, "utf-8");
    return yaml.load(raw);
}
function getByPath(obj, path) {
    const parts = path.split(".").filter(Boolean);
    let cur = obj;
    for (const p of parts) {
        if (cur == null)
            return undefined;
        cur = cur[p];
    }
    return cur;
}
// Same tiny evaluator as runner (MVP)
function evalWhen(expr, ctx) {
    const m = expr.trim().match(/^([a-zA-Z0-9_\.]+)\s*(==|>=|<=|>|<)\s*(.+)$/);
    if (!m)
        return false;
    const [, leftPath, op, rightRaw] = m;
    const left = getByPath(ctx, leftPath);
    let right = rightRaw.trim();
    if (right === "true")
        right = true;
    else if (right === "false")
        right = false;
    else if (!Number.isNaN(Number(right)))
        right = Number(right);
    else
        right = right.replace(/^['\"]|['\"]$/g, "");
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
function loadRunEvents(runId) {
    const p = join(w3rtDir(), "runs", runId, "trace.jsonl");
    if (!existsSync(p)) {
        throw new Error(`No trace found for runId ${runId}. Expected: ${p}`);
    }
    const raw = readFileSync(p, "utf-8");
    return raw
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
}
function inferWorkflowPathFromRun(events) {
    const started = events.find((e) => e.type === "run.started");
    const name = started?.data?.workflow;
    if (!name)
        throw new Error("Missing workflow name in run.started");
    // Convention: workflows are in repo `workflows/<name>.yaml`
    const candidate = resolve(process.cwd(), "workflows", `${name}.yaml`);
    if (existsSync(candidate))
        return candidate;
    // Fallback: try yml
    const candidate2 = resolve(process.cwd(), "workflows", `${name}.yml`);
    if (existsSync(candidate2))
        return candidate2;
    throw new Error(`Cannot find workflow file for '${name}'. Expected ${candidate}`);
}
function findArtifact(events, tool, stepId) {
    // Find the tool.result event for that tool+step.
    const ev = events.find((e) => e.type === "tool.result" && e.tool === tool && e.stepId === stepId);
    const ref = ev?.artifactRefs?.[0];
    if (ref?.path)
        return ref.path;
    // Fallback to known naming convention in artifacts dir.
    const base = join(w3rtDir(), "runs", events[0]?.runId ?? "", "artifacts");
    const prefixes = {
        solana_jupiter_quote: `quote_${stepId}`,
        solana_jupiter_build_tx: `built_${stepId}`,
        solana_simulate_tx: `simulation_${stepId}`,
        solana_send_tx: `submitted_${stepId}`,
        solana_confirm_tx: `confirmed_${stepId}`,
    };
    const n = prefixes[tool];
    if (!n)
        return null;
    const p = join(base, `${n}.json`);
    return existsSync(p) ? p : null;
}
function applyResultBindings(tool, result, ctx) {
    // Keep consistent with runner bindings
    if (tool === "solana_jupiter_quote")
        ctx.quote = result;
    if (tool === "solana_jupiter_build_tx")
        ctx.built = result;
    if (tool === "solana_simulate_tx")
        ctx.simulation = result;
    if (tool === "solana_send_tx")
        ctx.submitted = result;
    if (tool === "solana_confirm_tx")
        ctx.confirmed = result;
}
export function replayDry(runId, opts = {}) {
    const events = loadRunEvents(runId);
    const wfPath = opts.workflowPath ? resolve(process.cwd(), opts.workflowPath) : inferWorkflowPathFromRun(events);
    const wf = loadYamlFile(wfPath);
    const ctx = {};
    const missingArtifacts = [];
    console.log(`replay --dry runId: ${runId}`);
    console.log(`workflow: ${wf.name} v${wf.version}`);
    console.log(`workflowPath: ${wfPath}`);
    for (const stage of wf.stages) {
        if (stage.when) {
            const ok = evalWhen(stage.when, ctx);
            console.log(`- stage ${stage.name}: when (${stage.when}) => ${ok}`);
            if (!ok)
                continue;
        }
        else {
            console.log(`- stage ${stage.name}: when => true`);
        }
        if (stage.type === "approval" && stage.approval?.required) {
            const conditions = stage.approval?.conditions ?? [];
            if (!conditions.length) {
                console.log(`  - approval: required (no conditions)`);
            }
            else {
                console.log(`  - approval: required`);
                for (const c of conditions) {
                    const ok = evalWhen(c, ctx);
                    console.log(`    - condition (${c}) => ${ok}`);
                }
            }
            const allOk = conditions.every((c) => evalWhen(c, ctx));
            if (!allOk)
                throw new Error(`Approval conditions failed for stage ${stage.name}`);
            continue;
        }
        for (const action of stage.actions) {
            const stepId = stage.name;
            const tool = action.tool;
            const artifactPath = findArtifact(events, tool, stepId);
            if (!artifactPath) {
                missingArtifacts.push({ stepId, tool });
                console.log(`  - ${tool}: MISSING artifact`);
                continue;
            }
            const result = JSON.parse(readFileSync(artifactPath, "utf-8"));
            applyResultBindings(tool, result, ctx);
            console.log(`  - ${tool}: loaded artifact ${artifactPath}`);
        }
    }
    if (missingArtifacts.length) {
        console.log("\nmissing artifacts:");
        for (const m of missingArtifacts)
            console.log(`- step=${m.stepId} tool=${m.tool}`);
    }
    console.log("\nreplay --dry: OK");
}
// deprecated helper (kept for compatibility in history)
function awaitReplayAction(_runId, _events, _stage, _action, _ctx) {
    // no-op
}
//# sourceMappingURL=replay_cmd.js.map