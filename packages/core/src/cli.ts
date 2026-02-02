#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import readline from "node:readline";

import { runWorkflowFromFile } from "./run.js";

function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(`${prompt} (y/N) `, (ans: string) => {
      rl.close();
      res(ans.trim().toLowerCase() === "y");
    });
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
    console.log(
      "w3rt - Web3 AI Runtime (scaffold)\n\nCommands:\n  w3rt run <workflow.yml>\n  w3rt policy show\n"
    );
    process.exit(0);
  }

  if (args[0] === "policy" && args[1] === "show") {
    const p = join(process.cwd(), ".w3rt", "policy.yaml");
    try {
      console.log(readFileSync(p, "utf-8"));
    } catch {
      console.error("No policy.yaml found at .w3rt/policy.yaml");
      process.exit(1);
    }
    return;
  }

  if (args[0] === "run" && args[1]) {
    const wfPath = resolve(process.cwd(), args[1]);
    const { runId, summary } = await runWorkflowFromFile(wfPath, { approve: confirm });
    console.log(`runId: ${runId}`);
    console.log(`trace: ~/.w3rt/runs/${runId}/trace.jsonl`);

    if (summary?.signature) {
      console.log(`signature: ${summary.signature}`);
    }
    if (summary?.explorerUrl) {
      console.log(`explorer: ${summary.explorerUrl}`);
    }

    return;
  }

  console.error("Unknown command:", args.join(" "));
  process.exit(2);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
