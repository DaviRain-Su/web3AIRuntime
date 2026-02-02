#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
    console.log("w3rt - Web3 AI Runtime (scaffold)\n\nCommands:\n  w3rt run <workflow.yml>\n  w3rt policy show\n  w3rt trace <run-id>\n");
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

  console.error("Not implemented yet:", args.join(" "));
  process.exit(2);
}

main();
