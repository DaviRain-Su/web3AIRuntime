import {
  runWorkflowFromFile,
  printRunTrace,
  replayDry,
  policySuggestFromRun,
} from "@w3rt/core";

// Pi SDK types are intentionally loose for now (we'll tighten after we pin Pi APIs).
export default function w3rtPiExtension(pi: any) {
  // Register commands in Pi
  if (typeof pi?.registerCommand !== "function") return;

  // w3rt.run <workflowPath>
  pi.registerCommand("w3rt.run", {
    description: "Run a w3rt workflow (YAML)",
    execute: async (args: string[] = [], ctx: any) => {
      const workflowPath = args[0];
      if (!workflowPath) {
        ctx?.ui?.print?.("Usage: /w3rt.run <workflowPath>");
        return;
      }

      const approve = async (prompt: string) => {
        if (ctx?.ui?.confirm) return await ctx.ui.confirm("w3rt approval", prompt);
        return false;
      };

      const { runId, summary } = await runWorkflowFromFile(workflowPath, { approve });

      ctx?.ui?.print?.(`runId: ${runId}`);
      if (summary?.signature) ctx?.ui?.print?.(`signature: ${summary.signature}`);
      if (summary?.explorerUrl) ctx?.ui?.print?.(`explorer: ${summary.explorerUrl}`);
    },
  });

  // w3rt.trace <runId>
  pi.registerCommand("w3rt.trace", {
    description: "Show a w3rt run trace summary",
    execute: async (args: string[] = [], ctx: any) => {
      const runId = args[0];
      if (!runId) {
        ctx?.ui?.print?.("Usage: /w3rt.trace <runId>");
        return;
      }
      // prints to stdout; in Pi we mirror to UI when possible
      try {
        printRunTrace(runId);
      } catch (e: any) {
        ctx?.ui?.print?.(String(e?.message ?? e));
      }
    },
  });

  // w3rt.replay --dry <runId> [--workflow <path>]
  pi.registerCommand("w3rt.replay", {
    description: "Replay a run in dry mode (validator)",
    execute: async (args: string[] = [], ctx: any) => {
      const runId = args[0];
      if (!runId) {
        ctx?.ui?.print?.("Usage: /w3rt.replay <runId> [--workflow <path>]");
        return;
      }
      const wfIdx = args.findIndex((a) => a === "--workflow");
      const workflowPath = wfIdx !== -1 ? args[wfIdx + 1] : undefined;
      try {
        replayDry(runId, { workflowPath });
      } catch (e: any) {
        ctx?.ui?.print?.(String(e?.message ?? e));
      }
    },
  });

  // w3rt.policy.suggest --from-run <runId>
  pi.registerCommand("w3rt.policy.suggest", {
    description: "Suggest Solana allowlist programs from a run",
    execute: async (args: string[] = [], ctx: any) => {
      const runId = args[0];
      if (!runId) {
        ctx?.ui?.print?.("Usage: /w3rt.policy.suggest <runId>");
        return;
      }
      try {
        policySuggestFromRun(runId);
      } catch (e: any) {
        ctx?.ui?.print?.(String(e?.message ?? e));
      }
    },
  });
}
