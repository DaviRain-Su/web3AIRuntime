import http from "node:http";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import yaml from "js-yaml";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Commitment,
} from "@solana/web3.js";

import { SolanaDriver, EvmDriver, type ChainDriver } from "./driver/index.js";
import { computeArtifactHash } from "./artifactHash.js";

import { defaultRegistry, jupiterAdapter, meteoraDlmmAdapter, solendAdapter } from "@w3rt/adapters";
import { PolicyEngine, type PolicyConfig } from "@w3rt/policy";
import { TraceStore } from "@w3rt/trace";

import { loadSolanaKeypair, resolveSolanaRpc } from "./run.js";

type Dict = Record<string, any>;

type PlanAction = {
  id?: string;
  dependsOn?: string[];
  chain?: string;
  adapter?: string;
  action?: string;
  params?: Dict;
};

function makeDriverRegistry(rpcUrl: string): Record<string, ChainDriver> {
  // Future: allow per-chain rpcUrl overrides in ctx.
  return {
    solana: new SolanaDriver(),
    evm: new EvmDriver(),
  };
}

function normalizeActions(raw: any): PlanAction[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((a, i) => ({
    id: String(a?.id ?? `a${i}`),
    dependsOn: Array.isArray(a?.dependsOn) ? a.dependsOn.map((x: any) => String(x)) : [],
    chain: String(a?.chain ?? "solana"),
    adapter: String(a?.adapter ?? ""),
    action: String(a?.action ?? ""),
    params: (a?.params ?? {}) as Dict,
  }));
}

function topoOrderActions(actions: PlanAction[]): { ordered: PlanAction[]; cycles: string[] } {
  const byId = new Map(actions.map((a) => [String(a.id), a]));
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();

  for (const a of actions) {
    const id = String(a.id);
    indeg.set(id, 0);
    out.set(id, []);
  }

  for (const a of actions) {
    const id = String(a.id);
    for (const dep of a.dependsOn ?? []) {
      if (!byId.has(dep)) continue; // ignore missing deps for now
      indeg.set(id, (indeg.get(id) ?? 0) + 1);
      out.get(dep)!.push(id);
    }
  }

  const q: string[] = [];
  for (const [id, d] of indeg.entries()) if (d === 0) q.push(id);

  const ordered: PlanAction[] = [];
  while (q.length) {
    const id = q.shift()!;
    const a = byId.get(id);
    if (a) ordered.push(a);
    for (const nxt of out.get(id) ?? []) {
      indeg.set(nxt, (indeg.get(nxt) ?? 0) - 1);
      if ((indeg.get(nxt) ?? 0) === 0) q.push(nxt);
    }
  }

  const cycles = [...indeg.entries()].filter(([, d]) => d! > 0).map(([id]) => id);
  return { ordered, cycles };
}

function findRepoRoot(): string {
  // Try cwd first (common when running via repo root).
  const starts = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  for (const start of starts) {
    let cur = start;
    for (let i = 0; i < 8; i++) {
      const pj = join(cur, "package.json");
      if (existsSync(pj)) {
        try {
          const j = JSON.parse(readFileSync(pj, "utf-8"));
          if (j?.name === "web3-ai-runtime" && Array.isArray(j?.workspaces)) return cur;
        } catch {
          // ignore
        }
      }
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  // fallback: assume cwd is good
  return process.cwd();
}

function spawnAsync(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveP, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const to = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`spawn timeout after ${opts.timeoutMs ?? 30_000}ms`));
    }, opts.timeoutMs ?? 30_000);

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d) => (stdout += d.toString("utf-8")));
    child.stderr?.on("data", (d) => (stderr += d.toString("utf-8")));

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
        return reject(err);
      }
      resolveP({ stdout, stderr });
    });

    if (opts.input != null) {
      child.stdin?.write(opts.input);
    }
    child.stdin?.end();
  });
}

async function solendPrepareDepositTx(params: {
  rpcUrl: string;
  userPublicKey: string;
  amountBase: string;
  symbol?: string;
}): Promise<{ txB64: string; simulation: Prepared["simulation"]; meta?: any; programIds?: string[] }> {
  const repoRoot = findRepoRoot();
  const workerDir = join(repoRoot, "packages", "solend-worker");
  const workerPath = join(workerDir, "worker.js");

  const input = {
    rpcUrl: params.rpcUrl,
    userPublicKey: params.userPublicKey,
    amountBase: params.amountBase,
    symbol: params.symbol ?? "USDC",
  };

  const { stdout } = await spawnAsync(process.execPath, [workerPath], {
    cwd: workerDir,
    timeoutMs: 60_000,
    input: JSON.stringify(input),
  });

  // worker prints single-line JSON
  const raw = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  const j = raw ? JSON.parse(raw) : null;
  if (!j?.ok) {
    throw new Error(`solend-worker failed: ${j?.error ?? "UNKNOWN"} ${j?.message ?? ""}`.trim());
  }

  const simulation: Prepared["simulation"] = j.simulation
    ? {
        ok: j.simulation.err == null,
        err: j.simulation.err ?? undefined,
        logs: j.simulation.logs ?? [],
        unitsConsumed: j.simulation.unitsConsumed ?? null,
      }
    : undefined;

  return { txB64: String(j.txB64), simulation, meta: j.meta, programIds: j.programIds };
}

type Prepared = {
  preparedId: string;
  createdAt: number;
  expiresAt: number;
  traceId: string;
  chain: "solana";
  adapter: string;
  action: string;
  params: Dict;
  txB64: string;
  // extra signers (secret keys); NEVER returned to client; memory-only
  extraSigners?: Uint8Array[];
  simulation?: { ok: boolean; err?: any; logs?: string[]; unitsConsumed?: number | null };
  programIds?: string[];
  programIdsKnown: boolean;
  network: "mainnet" | "devnet" | "testnet" | "unknown";
};

function defaultW3rtDir() {
  return join(os.homedir(), ".w3rt");
}

function loadYamlFile<T>(path: string): T {
  const raw = readFileSync(path, "utf-8");
  return yaml.load(raw) as T;
}

function inferNetworkFromRpcUrl(rpcUrl: string): Prepared["network"] {
  const u = rpcUrl.toLowerCase();
  if (u.includes("devnet")) return "devnet";
  if (u.includes("testnet")) return "testnet";
  // heuristic; many private RPCs are mainnet
  if (u.includes("mainnet")) return "mainnet";
  return "unknown";
}

// (moved to SolanaDriver)

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res: http.ServerResponse, code: number, body: any) {
  const data = JSON.stringify(body, null, 2);
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(data);
}

function notFound(res: http.ServerResponse) {
  sendJson(res, 404, { ok: false, error: "NOT_FOUND" });
}

function registerAdapters() {
  for (const a of [jupiterAdapter, meteoraDlmmAdapter, solendAdapter]) {
    try {
      defaultRegistry.register(a);
    } catch {
      // ignore duplicate
    }
  }
}

export async function startDaemon(opts: { port?: number; host?: string; w3rtDir?: string; preparedTtlMs?: number } = {}) {
  registerAdapters();

  const port = opts.port ?? Number(process.env.W3RT_DAEMON_PORT ?? 8787);
  const host = opts.host ?? String(process.env.W3RT_DAEMON_HOST ?? "127.0.0.1");
  const w3rtDir = opts.w3rtDir ?? defaultW3rtDir();
  const ttlMs = opts.preparedTtlMs ?? 15 * 60 * 1000;

  mkdirSync(w3rtDir, { recursive: true });

  // policy config (optional)
  let policy: PolicyEngine | undefined;
  try {
    const policyCfg = loadYamlFile<PolicyConfig>(join(process.cwd(), ".w3rt", "policy.yaml"));
    policy = new PolicyEngine(policyCfg);
  } catch {
    policy = undefined;
  }

  const prepared = new Map<string, Prepared>();

  // cleanup timer
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of prepared.entries()) {
      if (v.expiresAt <= now) prepared.delete(k);
    }
  }, 10_000).unref();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      // health
      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true });
      }

      // List all available actions (capabilities) across registered adapters.
      if (req.method === "GET" && url.pathname === "/v1/actions") {
        const adapters = defaultRegistry.list().map((a) => {
          const caps = a.capabilities?.() ?? [];
          return {
            id: a.id,
            chain: a.chain,
            capabilities: caps,
          };
        });

        const actions = adapters.flatMap((a) =>
          (a.capabilities ?? []).map((c: any) => ({
            adapter: a.id,
            chain: a.chain,
            ...c,
          }))
        );

        return sendJson(res, 200, { ok: true, adapters, actions });
      }

      // MVP: Stable-yield opportunity discovery (mock providers for now)
      if (req.method === "POST" && url.pathname === "/v1/strategies/stable-yield/discover") {
        const body = await readJsonBody(req);
        const amountUsd = Number(body.amountUsd ?? 0);
        const stableMint = String(body.stableMint ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC

        const opportunities = [
          {
            id: "solana:lending:mock-a",
            chain: "solana",
            stableMint,
            name: "Lending (mock) — flexible USDC supply",
            provider: "mock",
            apy: 0.06,
            tvlUsd: 50_000_000,
            exit: { kind: "instant" },
            risk: "low",
            notes: "MVP placeholder. Replace with a real lending integration (e.g. Solend).",
            requiredActions: [
              {
                adapter: "solend",
                action: "solana.solend.deposit_usdc",
                params: { amountBase: String(Math.max(0, Math.floor(amountUsd * 1_000_000))) },
              },
            ],
          },
          {
            id: "solana:vault:mock-b",
            chain: "solana",
            stableMint,
            name: "Vault (mock) — auto-compound USDC",
            provider: "mock",
            apy: 0.075,
            tvlUsd: 12_000_000,
            exit: { kind: "instant" },
            risk: "medium",
            notes: "MVP placeholder. Replace with a real vault integration.",
            requiredActions: [
              {
                adapter: "solend",
                action: "solana.solend.deposit_usdc",
                params: { amountBase: String(Math.max(0, Math.floor(amountUsd * 1_000_000))) },
              },
            ],
          },
        ];

        // Basic ranking: higher APY first, then TVL
        opportunities.sort((a, b) => b.apy - a.apy || b.tvlUsd - a.tvlUsd);

        return sendJson(res, 200, { ok: true, opportunities });
      }

      // MVP: Plan a stable-yield strategy from discovery results.
      // Returns an execution plan (action intents) that can later be compiled into workflow/transactions.
      if (req.method === "POST" && url.pathname === "/v1/strategies/stable-yield/plan") {
        const body = await readJsonBody(req);
        const amountUsd = Number(body.amountUsd ?? 0);
        const stableMint = String(body.stableMint ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
        const riskPreference = String(body.risk ?? "low"); // low|medium
        const mode = String(body.mode ?? "deposit"); // deposit|migrate

        // Reuse the discovery logic (mock) for now.
        const disc = await (async () => {
          const opportunities = [
            {
              id: "solana:lending:mock-a",
              chain: "solana",
              stableMint,
              name: "Lending (mock) — flexible USDC supply",
              provider: "mock",
              apy: 0.06,
              tvlUsd: 50_000_000,
              exit: { kind: "instant" },
              risk: "low",
              notes: "MVP placeholder. Replace with a real lending integration (e.g. Solend).",
              requiredActions: [
                {
                  adapter: "solend",
                  action: "solana.solend.deposit_usdc",
                  params: { amountBase: String(Math.max(0, Math.floor(amountUsd * 1_000_000))) },
                },
              ],
            },
            {
              id: "solana:vault:mock-b",
              chain: "solana",
              stableMint,
              name: "Vault (mock) — auto-compound USDC",
              provider: "mock",
              apy: 0.075,
              tvlUsd: 12_000_000,
              exit: { kind: "instant" },
              risk: "medium",
              notes: "MVP placeholder. Replace with a real vault integration.",
              requiredActions: [
                {
                  adapter: "solend",
                  action: "solana.solend.deposit_usdc",
                  params: { amountBase: String(Math.max(0, Math.floor(amountUsd * 1_000_000))) },
                },
              ],
            },
          ];
          opportunities.sort((a, b) => b.apy - a.apy || b.tvlUsd - a.tvlUsd);
          return opportunities;
        })();

        // Filter by risk preference (simple): low only allows low-risk opps.
        const candidates = riskPreference === "low" ? disc.filter((o: any) => o.risk === "low") : disc;
        const chosen = candidates[0] ?? disc[0];
        if (!chosen) return sendJson(res, 400, { ok: false, error: "NO_OPPORTUNITIES" });

        if (mode !== "deposit") {
          return sendJson(res, 400, {
            ok: false,
            error: "UNSUPPORTED_MODE",
            message: "MVP only supports mode=deposit for now",
          });
        }

        const planId = `plan_${crypto.randomUUID().slice(0, 16)}`;
        const plan = {
          id: planId,
          kind: "stable_yield",
          chain: "solana",
          mode: "deposit",
          input: { stableMint, amountUsd, riskPreference },
          chosenOpportunity: chosen,
          // Action intents (to be compiled). This is the "composability" layer.
          actions: chosen.requiredActions,
          explanation: `Pick ${chosen.name} with estimated APY ${(chosen.apy * 100).toFixed(2)}% and ${chosen.exit.kind} exit`,
        };

        return sendJson(res, 200, { ok: true, plan });
      }

      // Composable: stable-yield "prepare" should return an action plan (DAG), not a chain-specific tx.
      // Use /v1/plan/compile to compile plans into PreparedTx artifacts.
      if (req.method === "POST" && url.pathname === "/v1/strategies/stable-yield/prepare") {
        const body = await readJsonBody(req);
        const amountUsd = Number(body.amountUsd ?? 0);
        const stableMint = String(body.stableMint ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
        const riskPreference = String(body.risk ?? "low");

        const planId = `plan_${crypto.randomUUID().slice(0, 16)}`;
        const amountBase = String(Math.max(0, Math.floor(amountUsd * 1_000_000))); // USDC base units

        // For now we only support USDC deposit via Solend as the real integration.
        // Future: add swap action when stableMint != USDC, multi-step DAG, multi-chain strategies.
        const plan = {
          id: planId,
          kind: "stable_yield",
          chain: "solana",
          mode: "deposit",
          input: { amountUsd, stableMint, riskPreference },
          actions: [
            {
              id: "deposit",
              dependsOn: [],
              chain: "solana",
              adapter: "solend",
              action: "solana.solend.deposit_usdc",
              params: { amountBase },
            },
          ],
        };

        return sendJson(res, 200, { ok: true, plan, next: { compile: "/v1/plan/compile" } });
      }

      // Compile a plan (list/DAG of action intents) into chain-specific prepared artifacts.
      // For now: sequential compile for Solana; future: DAG execution + multi-chain drivers.
      if (req.method === "POST" && url.pathname === "/v1/plan/compile") {
        const body = await readJsonBody(req);
        const actions = normalizeActions(body.actions ?? body.plan?.actions);

        if (!actions.length) return sendJson(res, 400, { ok: false, error: "MISSING_ACTIONS" });

        const { ordered, cycles } = topoOrderActions(actions);
        if (cycles.length) return sendJson(res, 400, { ok: false, error: "PLAN_CYCLE", cycles });

        const kp = loadSolanaKeypair();
        if (!kp) return sendJson(res, 400, { ok: false, error: "MISSING_SOLANA_KEYPAIR" });

        const rpcUrl = resolveSolanaRpc();
        const network = inferNetworkFromRpcUrl(rpcUrl);
        const conn = new Connection(rpcUrl, { commitment: "confirmed" as Commitment });
        const drivers = makeDriverRegistry(rpcUrl);

        const traceId = crypto.randomUUID();
        const trace = new TraceStore(w3rtDir);
        trace.emit({ ts: Date.now(), type: "run.started", runId: traceId, data: { mode: "plan.compile", network, count: ordered.length } });

        const results: any[] = [];
        const resultById = new Map<string, any>();

        for (const [idx, a] of ordered.entries()) {
          const id = String(a.id);
          const adapter = String(a.adapter || "");
          const action = String(a.action || "");
          const params = (a.params ?? {}) as Dict;
          const chain = String(a.chain || "solana");

          // Dependency check: if any dep failed/blocked, skip compile.
          const deps = a.dependsOn ?? [];
          const depFailed = deps.some((d) => {
            const r = resultById.get(String(d));
            return r && (r.ok === false || r.allowed === false);
          });
          if (depFailed) {
            const r = { ok: false, id, error: "DEP_FAILED", dependsOn: deps };
            results.push(r);
            resultById.set(id, r);
            continue;
          }

          const driver = drivers[chain];
          if (!driver) {
            const r = { ok: false, id, error: "UNSUPPORTED_CHAIN", chain, adapter, action };
            results.push(r);
            resultById.set(id, r);
            continue;
          }

          // build tx
          let built: any;
          try {
            built = await defaultRegistry.get(adapter).buildTx(action, params, {
              userPublicKey: kp.publicKey.toBase58(),
              rpcUrl,
            });
          } catch (e: any) {
            const r = { ok: false, id, error: "UNKNOWN_ADAPTER", adapter, action, message: String(e?.message ?? e) };
            results.push(r);
            resultById.set(id, r);
            continue;
          }

          const txB64 = built.txB64;

          // simulate (chain driver)
          const simulation = await driver.simulateTxB64(txB64, { rpcUrl });

          const { ids: programIds, known } = await driver.extractIdsFromTxB64(txB64, { rpcUrl });

          const decision = policy
            ? policy.decide({
                chain: "solana",
                network,
                action,
                sideEffect: "none",
                simulationOk: simulation.ok,
                programIdsKnown: known,
                programIds,
              } as any)
            : { decision: "allow" };

          const requiresApproval = decision.decision === "confirm";
          const allowed = decision.decision === "allow" || decision.decision === "confirm";

          const preparedId = `prep_${crypto.randomUUID().slice(0, 16)}`;
          const now = Date.now();
          prepared.set(preparedId, {
            preparedId,
            createdAt: now,
            expiresAt: now + ttlMs,
            traceId,
            chain: "solana",
            adapter,
            action,
            params,
            txB64,
            simulation,
            programIds,
            programIdsKnown: known,
            network,
          });

          const artifact = {
            chain,
            adapter,
            action,
            params,
            txB64,
            simulation,
            programIds,
            policy: { decision: decision.decision },
            traceId,
            preparedId,
          };

          const hash = computeArtifactHash(artifact);

          const out = {
            ok: true,
            id,
            index: idx,
            dependsOn: deps,
            adapter,
            action,
            preparedId,
            allowed,
            requiresApproval,
            simulation,
            programIds,
            programIdsKnown: known,
            meta: built.meta ?? {},
            policyReport: decision,
            hashAlg: hash.hashAlg,
            artifactHash: hash.artifactHash,
          };
          results.push(out);
          resultById.set(id, out);

          trace.emit({ ts: Date.now(), type: "step.finished", runId: traceId, stepId: `compile_${id}`, data: { ok: true, id, adapter, action, simulationOk: simulation.ok, policy: decision } });
        }

        trace.emit({ ts: Date.now(), type: "run.finished", runId: traceId, data: { ok: true } });

        return sendJson(res, 200, { ok: true, traceId, order: ordered.map((a) => a.id), results });
      }

      if (req.method === "POST" && url.pathname === "/v1/actions/prepare") {
        const body = await readJsonBody(req);
        const chain = String(body.chain || "solana");
        const adapter = String(body.adapter || "");
        const action = String(body.action || "");
        const params = (body.params ?? {}) as Dict;

        if (chain !== "solana") return sendJson(res, 400, { ok: false, error: "UNSUPPORTED_CHAIN" });
        if (!adapter) return sendJson(res, 400, { ok: false, error: "MISSING_ADAPTER" });
        if (!action) return sendJson(res, 400, { ok: false, error: "MISSING_ACTION" });

        const kp = loadSolanaKeypair();
        if (!kp) return sendJson(res, 400, { ok: false, error: "MISSING_SOLANA_KEYPAIR" });

        const rpcUrl = resolveSolanaRpc();
        const network = inferNetworkFromRpcUrl(rpcUrl);
        const conn = new Connection(rpcUrl, { commitment: "confirmed" as Commitment });
        const drivers = makeDriverRegistry(rpcUrl);
        const driver = drivers[chain];
        if (!driver) return sendJson(res, 400, { ok: false, error: "UNSUPPORTED_CHAIN" });

        const traceId = crypto.randomUUID();
        const trace = new TraceStore(w3rtDir);

        trace.emit({ ts: Date.now(), type: "run.started", runId: traceId, data: { mode: "prepare", chain, adapter, action, network } });

        // build tx
        const built = await defaultRegistry.get(adapter).buildTx(action, params, {
          userPublicKey: kp.publicKey.toBase58(),
          rpcUrl,
        });

        const txB64 = built.txB64;
        const extraSigners = (built as any).signers as Uint8Array[] | undefined;

        // simulate (chain driver)
        const simulation = await driver.simulateTxB64(txB64, { rpcUrl });

        // program ids (best-effort)
        const { ids: programIds, known } = await driver.extractIdsFromTxB64(txB64, { rpcUrl });

        // policy
        const decision = policy
          ? policy.decide({
              chain: "solana",
              network,
              action: String((built as any)?.meta?.action ?? action),
              sideEffect: "none",
              simulationOk: simulation.ok,
              programIds,
              programIdsKnown: known,
            } as any)
          : { decision: "allow" };

        const requiresApproval = decision.decision === "confirm";
        const allowed = decision.decision === "allow" || decision.decision === "confirm";

        const preparedId = `prep_${crypto.randomUUID().slice(0, 16)}`;
        const now = Date.now();

        prepared.set(preparedId, {
          preparedId,
          createdAt: now,
          expiresAt: now + ttlMs,
          traceId,
          chain: "solana",
          adapter,
          action,
          params,
          txB64,
          extraSigners,
          simulation,
          programIds,
          programIdsKnown: known,
          network,
        });

        trace.emit({
          ts: Date.now(),
          type: "step.finished",
          runId: traceId,
          stepId: "prepare",
          data: {
            ok: true,
            adapter,
            action,
            meta: built.meta,
            simulation: { ok: simulation.ok, unitsConsumed: simulation.unitsConsumed ?? null },
            policy: decision,
            programIdsKnown: known,
            programIds,
          },
        });
        trace.emit({ ts: Date.now(), type: "run.finished", runId: traceId, data: { ok: true } });

        const artifact = {
          chain,
          adapter,
          action: String((built as any)?.meta?.action ?? action),
          params,
          txB64,
          simulation,
          programIds,
          policy: { decision: decision.decision },
          traceId,
          preparedId,
        };
        const hash = computeArtifactHash(artifact);

        return sendJson(res, 200, {
          ok: true,
          allowed,
          requiresApproval,
          preparedId,
          txB64,
          traceId,
          policyReport: decision,
          simulation,
          hashAlg: hash.hashAlg,
          artifactHash: hash.artifactHash,
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/actions/execute") {
        const body = await readJsonBody(req);
        const preparedId = String(body.preparedId || "");
        const confirm = body.confirm === true;
        if (!preparedId) return sendJson(res, 400, { ok: false, error: "MISSING_PREPARED_ID" });
        if (!confirm) return sendJson(res, 400, { ok: false, error: "CONFIRM_REQUIRED" });

        const item = prepared.get(preparedId);
        if (!item) return sendJson(res, 404, { ok: false, error: "PREPARED_NOT_FOUND_OR_EXPIRED" });
        if (item.expiresAt <= Date.now()) {
          prepared.delete(preparedId);
          return sendJson(res, 404, { ok: false, error: "PREPARED_NOT_FOUND_OR_EXPIRED" });
        }

        const kp = loadSolanaKeypair();
        if (!kp) return sendJson(res, 400, { ok: false, error: "MISSING_SOLANA_KEYPAIR" });

        const rpcUrl = resolveSolanaRpc();
        const network = inferNetworkFromRpcUrl(rpcUrl);
        const conn = new Connection(rpcUrl, { commitment: "confirmed" as Commitment });

        const traceId = item.traceId; // reuse prepare traceId for now
        const trace = new TraceStore(defaultW3rtDir());

        // policy gate for broadcast
        const decision = policy
          ? policy.decide({
              chain: "solana",
              network,
              action: String(item.action),
              sideEffect: "broadcast",
              simulationOk: item.simulation?.ok === true,
              programIds: item.programIds ?? [],
              programIdsKnown: item.programIdsKnown === true,
            } as any)
          : { decision: "allow" };

        if (decision.decision === "block") {
          trace.emit({ ts: Date.now(), type: "step.finished", runId: traceId, stepId: "execute", data: { ok: false, policy: decision } });
          return sendJson(res, 403, { ok: false, error: "POLICY_BLOCK", policyReport: decision, traceId });
        }

        if (decision.decision === "confirm") {
          // caller already confirmed; proceed
        }

        // sign + send
        const raw = Buffer.from(item.txB64, "base64");
        const tx = VersionedTransaction.deserialize(raw);
        const extra = Array.isArray(item.extraSigners) ? item.extraSigners : [];
        const extraKps = extra.map((sk) => Keypair.fromSecretKey(sk));
        tx.sign([kp, ...extraKps]);

        const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });

        trace.emit({ ts: Date.now(), type: "step.finished", runId: traceId, stepId: "execute", data: { ok: true, signature: sig } });

        // one-shot use by default
        prepared.delete(preparedId);

        return sendJson(res, 200, { ok: true, signature: sig, traceId });
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/traces/")) {
        const traceId = decodeURIComponent(url.pathname.split("/").pop() || "");
        if (!traceId) return sendJson(res, 400, { ok: false, error: "MISSING_TRACE_ID" });

        const p = join(defaultW3rtDir(), "runs", traceId, "trace.jsonl");
        try {
          const raw = readFileSync(p, "utf-8");
          const lines = raw
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => {
              try {
                return JSON.parse(l);
              } catch {
                return { raw: l };
              }
            });
          return sendJson(res, 200, { ok: true, traceId, events: lines });
        } catch {
          return sendJson(res, 404, { ok: false, error: "TRACE_NOT_FOUND" });
        }
      }

      return notFound(res);
    } catch (err: any) {
      return sendJson(res, 500, { ok: false, error: "INTERNAL", message: String(err?.message ?? err) });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  // eslint-disable-next-line no-console
  console.log(`w3rt daemon listening on http://${host}:${port}`);
}
