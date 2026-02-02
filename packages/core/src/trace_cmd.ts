import { readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

type TraceEvent = {
  ts: number;
  type: string;
  runId: string;
  stepId?: string;
  tool?: string;
  data?: any;
};

function w3rtDir() {
  return process.env.W3RT_DIR || join(os.homedir(), ".w3rt");
}

export function printRunTrace(runId: string) {
  const p = join(w3rtDir(), "runs", runId, "trace.jsonl");
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      console.error(`No trace found for runId ${runId}`);
      console.error(`Expected: ${p}`);
      return;
    }
    throw e;
  }
  const lines = raw.split("\n").filter(Boolean);
  const events: TraceEvent[] = lines.map((l) => JSON.parse(l));

  const started = events.find((e) => e.type === "run.started");
  const finished = [...events].reverse().find((e) => e.type === "run.finished");

  console.log(`runId: ${runId}`);
  if (started?.data?.workflow) console.log(`workflow: ${started.data.workflow} v${started.data.version ?? ""}`);

  const solana = started?.data?.solana;
  if (solana?.network || solana?.rpcUrl || solana?.pubkey) {
    console.log(`solana: ${solana?.network ?? "?"}${solana?.pubkey ? ` | ${solana.pubkey}` : ""}`);
    if (solana?.rpcUrl) console.log(`rpc: ${solana.rpcUrl}`);
  }

  if (finished?.data) console.log(`status: ${finished.data.ok ? "ok" : "failed"}${finished.data.error ? ` (${finished.data.error})` : ""}`);

  const sigEv = [...events].reverse().find((e) => e.type === "tool.result" && e.tool === "solana_send_tx");
  const sig = sigEv?.data?.result?.signature;
  if (sig) console.log(`signature: ${sig}`);

  // If failed, try to print the last tool.error or simulate error summary.
  if (finished?.data?.ok === false) {
    const lastErr = [...events].reverse().find((e) => e.type === "tool.error");
    if (lastErr?.tool) {
      console.log(`lastErrorTool: ${lastErr.tool}`);
      if (lastErr?.data?.error) console.log(`lastError: ${lastErr.data.error}`);
    }

    const simRes = [...events].reverse().find(
      (e) => e.type === "tool.result" && e.tool === "solana_simulate_tx"
    );
    const sim = simRes?.data?.result;
    if (sim && sim.ok === false) {
      console.log("simulate: failed");
      if (sim.err) console.log(`simulate.err: ${JSON.stringify(sim.err)}`);
      if (Array.isArray(sim.logs) && sim.logs.length) {
        console.log("simulate.logs (tail):");
        for (const line of sim.logs.slice(-10)) console.log(`  ${line}`);
      }
    }
  }

  console.log("\nsteps:");
  for (const e of events) {
    if (e.type === "step.started") {
      console.log(`- ${e.stepId} (start)`);
    }
    if (e.type === "step.finished") {
      console.log(`- ${e.stepId} (done)`);
    }
  }
}
