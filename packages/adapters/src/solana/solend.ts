import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Adapter, AdapterCapability, BuildTxResult } from "../types.js";

type SolendWorkerOut = {
  ok: boolean;
  txB64?: string;
  simulation?: { err: any; logs?: string[]; unitsConsumed?: number | null };
  accounts?: any;
  programId?: string;
  error?: string;
  message?: string;
};

function spawnAsync(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string } = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });

    const to = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`spawn timeout after ${opts.timeoutMs ?? 30_000}ms`));
    }, opts.timeoutMs ?? 30_000);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => (stdout += d.toString("utf-8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf-8")));

    child.on("error", (e) => {
      clearTimeout(to);
      const err: any = new Error(`spawn failed: ${e.message}`);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(to);
      if (code !== 0) {
        const err: any = new Error(`spawn exit ${code}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });

    if (opts.input != null) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

function solendWorkerPath(): { cwd: string; path: string } {
  // adapters/dist/solana/solend.js -> packages/adapters/dist/solana
  // repo root is 3-4 levels up; but safest is to locate relative to this file:
  const here = dirname(fileURLToPath(import.meta.url));
  // dist layout: .../packages/adapters/dist/solana
  // worker lives at .../packages/solend-worker/worker.js
  const repoRoot = join(here, "..", "..", "..", "..");
  const workerDir = join(repoRoot, "packages", "solend-worker");
  const worker = join(workerDir, "worker.js");
  return { cwd: workerDir, path: worker };
}

export const solendAdapter: Adapter = {
  id: "solend",
  chain: "solana",

  capabilities(): AdapterCapability[] {
    return [
      {
        action: "solana.solend.deposit_usdc",
        description: "Solend deposit USDC into the main market (builds a v0 tx via isolated solend-worker)",
        risk: "high",
        paramsSchema: {
          type: "object",
          required: ["amountBase"],
          properties: {
            amountBase: { type: "string", description: "USDC amount in base units" },
          },
        },
      },
    ];
  },

  async buildTx(action, params, ctx): Promise<BuildTxResult> {
    if (action !== "solana.solend.deposit_usdc") throw new Error(`Unsupported action: ${action}`);

    const userPublicKey = String(ctx?.userPublicKey || "");
    const rpcUrl = String(ctx?.rpcUrl || "");
    if (!userPublicKey) throw new Error("Missing ctx.userPublicKey");
    if (!rpcUrl) throw new Error("Missing ctx.rpcUrl");

    const amountBase = String((params as any)?.amountBase ?? "0");

    const { cwd, path } = solendWorkerPath();

    const { stdout } = await spawnAsync(process.execPath, [path], {
      cwd,
      timeoutMs: 60_000,
      input: JSON.stringify({ rpcUrl, userPublicKey, amountBase, symbol: "USDC" }),
    });

    const lastLine = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    const out = (lastLine ? JSON.parse(lastLine) : null) as SolendWorkerOut | null;

    if (!out?.ok || !out?.txB64) {
      throw new Error(`solend-worker failed: ${out?.error ?? "UNKNOWN"} ${out?.message ?? ""}`.trim());
    }

    return {
      ok: true,
      txB64: out.txB64,
      meta: {
        chain: "solana",
        adapter: "solend",
        action,
        mints: { tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
        amounts: { inAmount: amountBase },
        programHints: out.programId ? [out.programId] : undefined,
      },
    };
  },
};
