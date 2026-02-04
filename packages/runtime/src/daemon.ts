import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Commitment,
} from "@solana/web3.js";

import { SolanaDriver, EvmDriver, type ChainDriver } from "./driver/index.js";
import { computeArtifactHash, canonicalizeObject } from "./artifactHash.js";
import { writeMemoryRecord } from "./memoryRecords.js";

import { defaultRegistry, jupiterAdapter, meteoraDlmmAdapter, solendAdapter } from "@w3rt/adapters";
import { PolicyEngine, type PolicyConfig, defaultPolicySpec, policyConfigFromSpec, type PolicySpec } from "@w3rt/policy";
import { TraceStore } from "@w3rt/trace";

import { loadSolanaKeypair, resolveSolanaRpc } from "./run.js";

// Minimal SPL helpers (copied from runtime solana tool):
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

function getAssociatedTokenAddressSync(mint: PublicKey, owner: PublicKey): PublicKey {
  // ATA = findProgramAddress([owner, tokenProgram, mint], associatedTokenProgram)
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

function createAssociatedTokenAccountIx(params: { payer: PublicKey; ata: PublicKey; owner: PublicKey; mint: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: params.ata, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: false, isWritable: false },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
}

function createSplTransferIx(params: { source: PublicKey; dest: PublicKey; owner: PublicKey; amount: bigint }): TransactionInstruction {
  // SPL Token Transfer (instruction=3)
  const data = Buffer.alloc(1 + 8);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(params.amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: params.source, isSigner: false, isWritable: true },
      { pubkey: params.dest, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

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
  recentBlockhash?: string;
  lastValidBlockHeight?: number;
  // extra signers (secret keys); NEVER returned to client; memory-only
  extraSigners?: Uint8Array[];
  simulation?: { ok: boolean; err?: any; logs?: string[]; unitsConsumed?: number | null };
  programIds?: string[];
  programIdsKnown: boolean;
  network: "mainnet" | "devnet" | "testnet" | "unknown";

  // Public verification helpers
  artifactSchemaVersion?: string;
  hashAlg?: string;
  artifactHash?: string;
  artifactCanonicalJson?: string;
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

function normalizePolicyAction(action: string): string {
  const a = String(action || "").toLowerCase();
  if (a.includes("swap")) return "swap";
  if (a.includes("transfer")) return "transfer";
  if (a.includes("balance")) return "balance";
  if (a.includes("quote")) return "quote";
  if (a.includes("simulate")) return "simulate";
  if (a.includes("confirm")) return "confirm";
  if (a.includes("metrics")) return "metrics.get";
  return String(action || "");
}

function safeParseTx(txB64: string): { recentBlockhash?: string } | null {
  try {
    const raw = Buffer.from(txB64, "base64");
    const tx = VersionedTransaction.deserialize(raw);
    return { recentBlockhash: (tx.message as any)?.recentBlockhash };
  } catch {
    return null;
  }
}

// Simple in-process concurrency limiter (no deps)
function createLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  }

  return { run };
}

const RPC_CONCURRENCY = Math.max(1, Number(process.env.W3RT_RPC_CONCURRENCY ?? 6));
const rpcLimiter = createLimiter(RPC_CONCURRENCY);

// Short TTL cache for frequently-called RPCs
const blockhashCache: { value: any | null; ts: number } = { value: null, ts: 0 };
const BLOCKHASH_TTL_MS = Math.max(200, Number(process.env.W3RT_BLOCKHASH_TTL_MS ?? 800));

async function getLatestBlockhashCached(conn: Connection) {
  const now = Date.now();
  if (blockhashCache.value && now - blockhashCache.ts < BLOCKHASH_TTL_MS) return blockhashCache.value;
  const latest = await rpcLimiter.run(() => conn.getLatestBlockhash("confirmed"));
  blockhashCache.value = latest;
  blockhashCache.ts = now;
  return latest;
}

async function refreshTxBlockhash(conn: Connection, tx: VersionedTransaction) {
  const latest = await getLatestBlockhashCached(conn);
  // Mutate in-place (works for v0 messages)
  (tx.message as any).recentBlockhash = latest.blockhash;
  return latest;
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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getSolanaTxDeltaSummary(conn: Connection, signature: string): Promise<{
  blockTime: number | null;
  slot: number | null;
  confirmationStatus: string | null;
  err: any;
  delta: any;
} | null> {
  try {
    const st = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const status = st?.value?.[0] ?? null;

    const tx = await conn.getTransaction(signature, {
      commitment: "confirmed" as Commitment,
      maxSupportedTransactionVersion: 0,
    } as any);

    const delta: any = {};
    try {
      const meta = (tx as any)?.meta;
      if (meta) {
        const pre = meta.preBalances ?? [];
        const post = meta.postBalances ?? [];
        const keys = ((tx as any)?.transaction as any)?.message?.accountKeys ?? [];
        const solDeltas = [];
        for (let i = 0; i < Math.min(pre.length, post.length, keys.length); i++) {
          const d = Number(post[i] ?? 0) - Number(pre[i] ?? 0);
          if (d !== 0) {
            solDeltas.push({
              account: String(keys[i]?.toBase58 ? keys[i].toBase58() : keys[i]),
              lamportsDelta: d,
              solDelta: d / 1_000_000_000,
            });
          }
        }
        delta.sol = solDeltas;

        const preTok = meta.preTokenBalances ?? [];
        const postTok = meta.postTokenBalances ?? [];
        const byKey = new Map<string, any>();
        for (const b of preTok) {
          const k = `${b.owner ?? ""}|${b.mint ?? ""}`;
          byKey.set(k, { owner: b.owner, mint: b.mint, pre: b.uiTokenAmount, post: null });
        }
        for (const b of postTok) {
          const k = `${b.owner ?? ""}|${b.mint ?? ""}`;
          const cur = byKey.get(k) ?? { owner: b.owner, mint: b.mint, pre: null, post: null };
          cur.post = b.uiTokenAmount;
          byKey.set(k, cur);
        }
        const tokenDeltas: any[] = [];
        for (const v of byKey.values()) {
          const preAmt = Number(v.pre?.uiAmount ?? 0);
          const postAmt = Number(v.post?.uiAmount ?? 0);
          const d = postAmt - preAmt;
          if (d !== 0) tokenDeltas.push({ owner: v.owner, mint: v.mint, uiDelta: d, pre: v.pre, post: v.post });
        }
        delta.tokens = tokenDeltas;

        delta.feeLamports = meta.fee ?? null;
        delta.err = meta.err ?? null;
      }
    } catch {
      // ignore
    }

    return {
      blockTime: (tx as any)?.blockTime ?? null,
      slot: (tx as any)?.slot ?? null,
      confirmationStatus: status?.confirmationStatus ?? null,
      err: status?.err ?? null,
      delta,
    };
  } catch {
    return null;
  }
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

  const portRaw = opts.port ?? Number(process.env.W3RT_DAEMON_PORT ?? 8787);
  const port = portRaw === 0 ? 0 : Number(portRaw);
  const host = opts.host ?? String(process.env.W3RT_DAEMON_HOST ?? "127.0.0.1");
  const w3rtDir = opts.w3rtDir ?? defaultW3rtDir();
  const ttlMs = opts.preparedTtlMs ?? 15 * 60 * 1000;

  mkdirSync(w3rtDir, { recursive: true });

  // policy config (optional)
  let policySpec: PolicySpec | null = null;
  let policy: PolicyEngine | undefined;

  const policyPath = join(w3rtDir, "policy.yaml");

  function reloadPolicyFromDisk(): { ok: boolean; error?: string } {
    try {
      const raw = loadYamlFile<any>(policyPath);
      // Accept either PolicySpec (preferred) or legacy PolicyConfig
      if (raw && typeof raw === "object" && raw.policySpecVersion === 1) {
        policySpec = raw as PolicySpec;
        const cfg = policyConfigFromSpec(policySpec);
        policy = new PolicyEngine(cfg);
      } else {
        policySpec = null;
        const cfg = raw as PolicyConfig;
        policy = new PolicyEngine(cfg);
      }
      return { ok: true };
    } catch (e: any) {
      policySpec = null;
      policy = undefined;
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  // best-effort load at boot
  if (existsSync(policyPath)) {
    reloadPolicyFromDisk();
  }

  const prepared = new Map<string, Prepared>();

  function loadRunStatus(runId: string): any | null {
    try {
      const p = join(w3rtDir, "runs", runId, "status.json");
      const raw = readFileSync(p, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function loadRunPlan(runId: string): any | null {
    try {
      const p = join(w3rtDir, "runs", runId, "plan.json");
      const raw = readFileSync(p, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function writeRunStatus(runId: string, patch: any) {
    const runDir = join(w3rtDir, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    const prev = loadRunStatus(runId) ?? { runId, status: "unknown", steps: {} };
    const next = {
      ...prev,
      ...patch,
      steps: { ...(prev.steps ?? {}), ...(patch.steps ?? {}) },
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(join(runDir, "status.json"), JSON.stringify(next, null, 2));
  }

  // executed (idempotency): preparedId -> { signature, ts }
  const executedPath = join(w3rtDir, "executed.json");
  const executed = new Map<string, { signature: string; ts: number }>();
  try {
    const raw = readFileSync(executedPath, "utf-8");
    const j = JSON.parse(raw);
    if (j && typeof j === "object") {
      for (const [k, v] of Object.entries(j)) {
        const sig = (v as any)?.signature;
        const ts = (v as any)?.ts;
        if (typeof sig === "string") executed.set(String(k), { signature: sig, ts: typeof ts === "number" ? ts : 0 });
      }
    }
  } catch {
    // ignore if missing/corrupt
  }

  function persistExecuted() {
    try {
      const obj: Record<string, any> = {};
      for (const [k, v] of executed.entries()) obj[k] = v;
      writeFileSync(executedPath, JSON.stringify(obj, null, 2));
    } catch {
      // best-effort
    }
  }

  // cleanup timer
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of prepared.entries()) {
      if (v.expiresAt <= now) prepared.delete(k);
    }
  }, 10_000).unref();

  // Resolve cache (process-wide) to reduce RPC pressure
  const RESOLVE_CACHE_TTL_MS = Math.max(0, Number(process.env.W3RT_RESOLVE_CACHE_TTL_MS ?? 4000));
  const resolveCache = new Map<string, { ts: number; value: any }>();

  // Minimal in-process metrics
  const metrics = {
    startedAt: new Date().toISOString(),
    config: {
      resolveCacheTtlMs: RESOLVE_CACHE_TTL_MS,
      adapterCooldownMs: Math.max(0, Number(process.env.W3RT_ADAPTER_COOLDOWN_MS ?? 2500)),
      quoteConcurrency: Math.max(1, Number(process.env.W3RT_QUOTE_CONCURRENCY ?? 2)),
      httpRps: Math.max(0, Number(process.env.W3RT_HTTP_RPS ?? 0)),
      httpBurst: Math.max(1, Number(process.env.W3RT_HTTP_BURST ?? 8)),
    },
    requests: {
      resolve_v0: { count: 0, ok: 0, fail: 0, avgMs: 0, maxMs: 0 },
      run_v0: { count: 0, ok: 0, fail: 0, avgMs: 0, maxMs: 0 },
      confirm_v0: { count: 0, ok: 0, fail: 0, avgMs: 0, maxMs: 0 },
      retry_v0: { count: 0, ok: 0, fail: 0, avgMs: 0, maxMs: 0 },
    },
    adapters: {
      jupiter: { ok: 0, fail: 0, r429: 0, timeout: 0 },
      meteora: { ok: 0, fail: 0, r429: 0, timeout: 0 },
      raydium: { ok: 0, fail: 0, r429: 0, timeout: 0 },
    } as Record<string, any>,
    adapterBackoff: {} as Record<string, any>,
    policyDecisions: { allow: 0, warn: 0, confirm: 0, block: 0 },
  };

  function observeRequest(name: keyof typeof metrics.requests, ms: number, ok: boolean) {
    const r = metrics.requests[name];
    r.count++;
    if (ok) r.ok++; else r.fail++;
    r.maxMs = Math.max(r.maxMs, ms);
    // incremental avg
    r.avgMs = r.count === 1 ? ms : r.avgMs + (ms - r.avgMs) / r.count;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      // health
      if (req.method === "GET" && url.pathname === "/health") {
        const addr = server.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : port;
        return sendJson(res, 200, { ok: true, host, port: actualPort });
      }

      // metrics
      if (req.method === "GET" && url.pathname === "/v1/metrics") {
        // best-effort snapshot (in case adapter backoff isn't initialized yet)
        try {
          snapshotAdapterBackoff();
        } catch {
          // ignore
        }
        return sendJson(res, 200, { ok: true, ...metrics, now: new Date().toISOString() });
      }

      // policy: natural language -> PolicySpec (deterministic MVP parser)
      // POST /v1/policy/from_text
      // Body: { text: string }
      if (req.method === "POST" && url.pathname === "/v1/policy/from_text") {
        const body = await readJsonBody(req);
        const text = String(body?.text ?? "").trim();
        if (!text) return sendJson(res, 400, { ok: false, error: "MISSING_TEXT" });

        const base = defaultPolicySpec();
        const warnings: string[] = [];

        // --- small deterministic parser (Chinese/English keywords)
        // maxSingleAmountUsd
        {
          const m = text.match(/(单笔|每笔|单次|per\s*tx|single)\s*[^\d]{0,20}?(\d+(?:\.\d+)?)(\s*)(usd|\$|美元|刀|usdc)?/i);
          if (m) {
            const v = Number(m[2]);
            if (Number.isFinite(v) && v >= 0) base.transactions.maxSingleAmountUsd = v;
          }
        }

        // maxSlippageBps
        {
          const m = text.match(/(滑点|slippage)\s*[^\d]{0,20}?(\d+(?:\.\d+)?)\s*%/i);
          if (m) {
            const pct = Number(m[2]);
            if (Number.isFinite(pct) && pct >= 0) base.transactions.maxSlippageBps = Math.round(pct * 100);
          }
        }

        // requireConfirmation
        if (/永不确认|不需要确认|never\s*confirm/i.test(text)) base.transactions.requireConfirmation = "never";
        else if (/总是确认|每次确认|always\s*confirm/i.test(text)) base.transactions.requireConfirmation = "always";
        else if (/大额确认|large\s*only|only\s*large/i.test(text)) base.transactions.requireConfirmation = "large";

        // actions allowlist hints
        if (/只允许/i.test(text) || /only\s+allow/i.test(text)) {
          const actions: string[] = [];
          if (/swap|兑换|换币|交易/i.test(text)) actions.push("swap");
          if (/transfer|转账/i.test(text)) actions.push("transfer");
          if (/balance|余额/i.test(text)) actions.push("balance");
          if (actions.length) {
            // keep minimal safe helpers always
            const keep = ["quote", "simulate", "confirm"];
            base.allowlist.actions = Array.from(new Set([...actions, ...keep]));
          } else {
            warnings.push("Could not infer allowed actions from text; using default allowlist.actions");
          }
        }

        // mainnet toggles
        if (/禁用主网|关闭主网|mainnet\s*off/i.test(text)) base.networks.mainnet.enabled = false;
        if (/主网必须模拟|require\s*simulation\s*on\s*mainnet/i.test(text)) base.networks.mainnet.requireSimulation = true;
        if (/主网必须确认|require\s*approval\s*on\s*mainnet/i.test(text)) base.networks.mainnet.requireApproval = true;

        const spec: PolicySpec = base;

        // lightweight validation
        const errors: string[] = [];
        if (spec.policySpecVersion !== 1) errors.push("policySpecVersion must be 1");
        if (!(spec.transactions.maxSlippageBps >= 0 && spec.transactions.maxSlippageBps <= 10000)) errors.push("maxSlippageBps out of range");
        if (!(spec.transactions.maxSingleAmountUsd >= 0)) errors.push("maxSingleAmountUsd must be >= 0");
        if (!spec.allowlist || !Array.isArray(spec.allowlist.actions)) errors.push("allowlist.actions must be an array");

        const summary = {
          networks: spec.networks,
          transactions: spec.transactions,
          allowActions: spec.allowlist.actions ?? [],
        };

        if (errors.length) return sendJson(res, 200, { ok: false, error: "SPEC_INVALID", errors, warnings, spec, summary });

        // also return legacy PolicyConfig for immediate engine consumption
        let config: PolicyConfig | null = null;
        try {
          config = policyConfigFromSpec(spec);
        } catch (e: any) {
          return sendJson(res, 200, { ok: false, error: "SPEC_TO_CONFIG_FAILED", message: String(e?.message ?? e), warnings, spec, summary });
        }

        return sendJson(res, 200, { ok: true, warnings, spec, summary, config });
      }

      // policy: get current
      // GET /v1/policy/current
      if (req.method === "GET" && url.pathname === "/v1/policy/current") {
        return sendJson(res, 200, {
          ok: true,
          path: policyPath,
          loaded: !!policy,
          spec: policySpec ?? null,
        });
      }

      // policy: apply (write to disk + load into engine)
      // POST /v1/policy/apply
      // Body: { spec?: PolicySpec, config?: PolicyConfig }
      if (req.method === "POST" && url.pathname === "/v1/policy/apply") {
        const body = await readJsonBody(req);
        const spec = body?.spec as PolicySpec | undefined;
        const cfg = body?.config as PolicyConfig | undefined;

        if (!spec && !cfg) return sendJson(res, 400, { ok: false, error: "MISSING_SPEC_OR_CONFIG" });

        mkdirSync(dirname(policyPath), { recursive: true });

        try {
          if (spec) {
            // Validate conversion
            policyConfigFromSpec(spec);
            writeFileSync(policyPath, yaml.dump(spec));
          } else {
            writeFileSync(policyPath, yaml.dump(cfg));
          }
        } catch (e: any) {
          return sendJson(res, 200, { ok: false, error: "WRITE_FAILED", message: String(e?.message ?? e) });
        }

        const rr = reloadPolicyFromDisk();
        if (!rr.ok) return sendJson(res, 200, { ok: false, error: "RELOAD_FAILED", message: rr.error });

        return sendJson(res, 200, { ok: true, path: policyPath, loaded: true, spec: policySpec ?? null });
      }

      // policy: reset to default
      // POST /v1/policy/reset
      if (req.method === "POST" && url.pathname === "/v1/policy/reset") {
        mkdirSync(dirname(policyPath), { recursive: true });
        try {
          writeFileSync(policyPath, yaml.dump(defaultPolicySpec()));
        } catch (e: any) {
          return sendJson(res, 200, { ok: false, error: "WRITE_FAILED", message: String(e?.message ?? e) });
        }
        const rr = reloadPolicyFromDisk();
        if (!rr.ok) return sendJson(res, 200, { ok: false, error: "RELOAD_FAILED", message: rr.error });
        return sendJson(res, 200, { ok: true, path: policyPath, loaded: true, spec: policySpec ?? null });
      }

      // Solana: balance (single-user convenience). If no address is provided, use default local keypair.
      // POST /v1/solana/balance
      // Optional: includeTokens=true, tokenMint=<mint> to include token balances.
      if (req.method === "POST" && url.pathname === "/v1/solana/balance") {
        const body = await readJsonBody(req);
        const rpcUrl = resolveSolanaRpc();
        const network = inferNetworkFromRpcUrl(rpcUrl);

        let address = String(body?.address ?? body?.owner ?? "").trim();
        if (!address) {
          const kp = loadSolanaKeypair();
          if (!kp) {
            return sendJson(res, 400, {
              ok: false,
              error: "MISSING_ADDRESS",
              message: "No address provided and no local Solana keypair configured",
              hint: "Provide {address} or set W3RT_SOLANA_PRIVATE_KEY / W3RT_SOLANA_KEYPAIR_PATH (or Solana CLI keypair path).",
            });
          }
          address = kp.publicKey.toBase58();
        }

        let pubkey: PublicKey;
        try {
          pubkey = new PublicKey(address);
        } catch {
          return sendJson(res, 400, { ok: false, error: "INVALID_ADDRESS", address });
        }

        const conn = new Connection(rpcUrl, { commitment: "confirmed" as Commitment });
        const lamports = await conn.getBalance(pubkey);
        const sol = lamports / 1_000_000_000;

        const out: any = {
          ok: true,
          chain: "solana",
          network,
          rpcUrl,
          address: pubkey.toBase58(),
          lamports,
          sol,
        };

        if (body?.includeTokens === true) {
          const tokenMint = body?.tokenMint ? String(body.tokenMint) : "";
          const includeZero = body?.includeZero === true;

          const resTok = tokenMint
            ? await conn.getParsedTokenAccountsByOwner(pubkey, { mint: new PublicKey(tokenMint) })
            : await conn.getParsedTokenAccountsByOwner(pubkey, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });

          let tokens = resTok.value.map((v) => {
            const info = (v.account.data as any).parsed.info;
            const ta = info.tokenAmount;
            return {
              pubkey: v.pubkey.toBase58(),
              mint: info.mint,
              amount: ta.amount,
              decimals: ta.decimals,
              uiAmount: ta.uiAmount,
            };
          });

          if (!includeZero) tokens = tokens.filter((t) => Number(t.amount) > 0);
          out.tokens = tokens;
        }

        return sendJson(res, 200, out);
      }

      // Solana: get transaction status/details
      // GET /v1/solana/tx/<signature>
      if (req.method === "GET" && url.pathname.startsWith("/v1/solana/tx/")) {
        const signature = decodeURIComponent(url.pathname.split("/").pop() || "").trim();
        if (!signature) return sendJson(res, 400, { ok: false, error: "MISSING_SIGNATURE" });

        const rpcUrl = resolveSolanaRpc();
        const network = inferNetworkFromRpcUrl(rpcUrl);
        const conn = new Connection(rpcUrl, { commitment: "confirmed" as Commitment });

        // 1) quick status
        let status: any = null;
        try {
          const s = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
          status = s?.value?.[0] ?? null;
        } catch (e: any) {
          // ignore
        }

        // 2) full tx (may be null if not found or pruned)
        let tx: any = null;
        try {
          tx = await conn.getTransaction(signature, {
            commitment: "confirmed" as Commitment,
            maxSupportedTransactionVersion: 0,
          } as any);
        } catch (e: any) {
          // ignore
        }

        // 3) compute a compact balance delta summary (best-effort)
        const delta: any = {};
        try {
          const meta = tx?.meta;
          if (meta) {
            // SOL deltas
            const pre = meta.preBalances ?? [];
            const post = meta.postBalances ?? [];
            const keys = (tx?.transaction as any)?.message?.accountKeys ?? [];
            const solDeltas = [];
            for (let i = 0; i < Math.min(pre.length, post.length, keys.length); i++) {
              const d = Number(post[i] ?? 0) - Number(pre[i] ?? 0);
              if (d !== 0) {
                solDeltas.push({
                  account: String(keys[i]?.toBase58 ? keys[i].toBase58() : keys[i]),
                  lamportsDelta: d,
                  solDelta: d / 1_000_000_000,
                });
              }
            }
            delta.sol = solDeltas;

            // token deltas
            const preTok = meta.preTokenBalances ?? [];
            const postTok = meta.postTokenBalances ?? [];
            const byKey = new Map<string, any>();
            for (const b of preTok) {
              const k = `${b.owner ?? ""}|${b.mint ?? ""}`;
              byKey.set(k, { owner: b.owner, mint: b.mint, pre: b.uiTokenAmount, post: null });
            }
            for (const b of postTok) {
              const k = `${b.owner ?? ""}|${b.mint ?? ""}`;
              const cur = byKey.get(k) ?? { owner: b.owner, mint: b.mint, pre: null, post: null };
              cur.post = b.uiTokenAmount;
              byKey.set(k, cur);
            }
            const tokenDeltas: any[] = [];
            for (const v of byKey.values()) {
              const preAmt = Number(v.pre?.uiAmount ?? 0);
              const postAmt = Number(v.post?.uiAmount ?? 0);
              const d = postAmt - preAmt;
              if (d !== 0) tokenDeltas.push({ owner: v.owner, mint: v.mint, uiDelta: d, pre: v.pre, post: v.post });
            }
            delta.tokens = tokenDeltas;

            delta.feeLamports = meta.fee ?? null;
            delta.err = meta.err ?? null;
          }
        } catch {
          // ignore
        }

        return sendJson(res, 200, {
          ok: true,
          chain: "solana",
          network,
          rpcUrl,
          signature,
          status,
          blockTime: tx?.blockTime ?? null,
          slot: tx?.slot ?? null,
          confirmationStatus: status?.confirmationStatus ?? null,
          err: status?.err ?? null,
          delta,
          // return raw tx only when available (may be large)
          tx,
        });
      }

      // Solana: transfer prepare (build unsigned tx + simulate + policy + returns preparedId). Does NOT broadcast.
      // POST /v1/solana/transfer/prepare
      if (req.method === "POST" && url.pathname === "/v1/solana/transfer/prepare") {
        const body = await readJsonBody(req);

        const kp = loadSolanaKeypair();
        if (!kp) return sendJson(res, 400, { ok: false, error: "MISSING_SOLANA_KEYPAIR" });

        const rpcUrl = resolveSolanaRpc();
        const network = inferNetworkFromRpcUrl(rpcUrl);

        const toRaw = String(body?.to ?? "").trim();
        if (!toRaw) return sendJson(res, 400, { ok: false, error: "MISSING_TO" });

        let to: PublicKey;
        try {
          to = new PublicKey(toRaw);
        } catch {
          return sendJson(res, 400, { ok: false, error: "INVALID_TO", to: toRaw });
        }

        const amountUi = Number(body?.amount);
        if (!Number.isFinite(amountUi) || amountUi <= 0) {
          return sendJson(res, 400, { ok: false, error: "INVALID_AMOUNT", amount: body?.amount });
        }

        const tokenMintRaw = body?.tokenMint ? String(body.tokenMint).trim() : "";
        const createAta = body?.createAta !== false;

        const conn = new Connection(rpcUrl, { commitment: "confirmed" as Commitment });

        const instructions: TransactionInstruction[] = [];
        const summary: any = { from: kp.publicKey.toBase58(), to: to.toBase58() };

        if (!tokenMintRaw) {
          // SOL transfer
          const lamports = Math.round(amountUi * 1_000_000_000);
          instructions.push(
            SystemProgram.transfer({
              fromPubkey: kp.publicKey,
              toPubkey: to,
              lamports,
            })
          );
          summary.kind = "sol_transfer";
          summary.amountUi = amountUi;
          summary.lamports = lamports;
        } else {
          // SPL transfer
          let tokenMint: PublicKey;
          try {
            tokenMint = new PublicKey(tokenMintRaw);
          } catch {
            return sendJson(res, 400, { ok: false, error: "INVALID_TOKEN_MINT", tokenMint: tokenMintRaw });
          }

          const mintAcc = await conn.getParsedAccountInfo(tokenMint, "confirmed");
          const decimals = (mintAcc.value?.data as any)?.parsed?.info?.decimals;
          if (typeof decimals !== "number") {
            return sendJson(res, 400, { ok: false, error: "TOKEN_DECIMALS_NOT_FOUND", tokenMint: tokenMint.toBase58() });
          }

          const amountBase = BigInt(Math.round(amountUi * Math.pow(10, decimals)));
          const fromAta = getAssociatedTokenAddressSync(tokenMint, kp.publicKey);
          const toAta = getAssociatedTokenAddressSync(tokenMint, to);

          let willCreateAta = false;
          if (createAta) {
            const info = await conn.getAccountInfo(toAta, "confirmed");
            if (!info) {
              willCreateAta = true;
              instructions.push(
                createAssociatedTokenAccountIx({
                  payer: kp.publicKey,
                  ata: toAta,
                  owner: to,
                  mint: tokenMint,
                })
              );
            }
          }

          instructions.push(createSplTransferIx({ source: fromAta, dest: toAta, owner: kp.publicKey, amount: amountBase }));

          summary.kind = "spl_transfer";
          summary.amountUi = amountUi;
          summary.amountBase = amountBase.toString();
          summary.decimals = decimals;
          summary.tokenMint = tokenMint.toBase58();
          summary.fromAta = fromAta.toBase58();
          summary.toAta = toAta.toBase58();
          summary.willCreateAta = willCreateAta;
        }

        const latest = await getLatestBlockhashCached(conn);
        const msg = new TransactionMessage({
          payerKey: kp.publicKey,
          recentBlockhash: latest.blockhash,
          instructions,
        }).compileToV0Message();

        const tx = new VersionedTransaction(msg);
        const txB64 = Buffer.from(tx.serialize()).toString("base64");

        const drivers = makeDriverRegistry(rpcUrl);
        const driver = drivers.solana;
        const simulation = await driver.simulateTxB64(txB64, { rpcUrl });
        const { ids: programIds, known } = await driver.extractIdsFromTxB64(txB64, { rpcUrl });

        const decision = policy
          ? policy.decide({
              chain: "solana",
              network,
              // Policy allowlist expects generic verbs like "transfer".
              action: "transfer",
              // This endpoint is prepare-only (no broadcast).
              sideEffect: "none",
              simulationOk: simulation.ok,
              programIdsKnown: known,
              programIds,
            } as any)
          : { decision: simulation.ok ? "confirm" : "block" };

        // metrics: policy decision
        if ((metrics as any).policyDecisions && (metrics as any).policyDecisions[decision.decision] != null) {
          (metrics as any).policyDecisions[decision.decision]++;
        }

        const requiresApproval = decision.decision === "confirm";
        const allowed = decision.decision === "allow" || decision.decision === "confirm";

        const preparedId = `prep_${crypto.randomUUID().slice(0, 16)}`;
        const now = Date.now();

        const traceId = `trace_${crypto.randomUUID().slice(0, 16)}`;
        const trace = new TraceStore(w3rtDir);
        trace.emit({ ts: now, type: "tx.built", runId: traceId, data: { summary } });
        trace.emit({ ts: now, type: "tx.simulated", runId: traceId, data: { ok: simulation.ok, err: simulation.err, unitsConsumed: simulation.unitsConsumed } });
        trace.emit({ ts: now, type: "policy.decision", runId: traceId, data: { decision } });

        const artifact = {
          chain: "solana",
          adapter: "internal",
          // Keep policy action compatible with allowlist: "transfer"
          action: "transfer",
          params: { to: to.toBase58(), amount: amountUi, tokenMint: tokenMintRaw || null, createAta },
          txB64,
          simulation,
          programIds,
          policy: { decision: decision.decision },
          traceId,
          preparedId,
          summary,
        };
        const hash = computeArtifactHash(artifact);

        prepared.set(preparedId, {
          preparedId,
          createdAt: now,
          expiresAt: now + ttlMs,
          traceId,
          chain: "solana",
          adapter: "internal",
          action: "transfer",
          params: artifact.params,
          txB64,
          recentBlockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
          simulation,
          programIds,
          programIdsKnown: known,
          network,
          artifactSchemaVersion: hash.schemaVersion,
          hashAlg: hash.hashAlg,
          artifactHash: hash.artifactHash,
          artifactCanonicalJson: hash.canonicalJson,
        });

        return sendJson(res, 200, {
          ok: true,
          preparedId,
          allowed,
          requiresApproval,
          network,
          rpcUrl,
          from: kp.publicKey.toBase58(),
          summary,
          simulation,
          programIds,
          programIdsKnown: known,
          policyReport: decision,
          artifactSchemaVersion: hash.schemaVersion,
          hashAlg: hash.hashAlg,
          artifactHash: hash.artifactHash,
        });
      }

      // Solana: transfer execute (broadcast) by preparedId.
      // POST /v1/solana/transfer/execute
      if (req.method === "POST" && url.pathname === "/v1/solana/transfer/execute") {
        const body = await readJsonBody(req);
        const preparedId = String(body.preparedId || "");
        const confirm = body.confirm === true;
        const waitForConfirmation = body.waitForConfirmation === true;
        const commitment = (body.commitment ? String(body.commitment) : "confirmed") as Commitment;
        const timeoutMs = body.timeoutMs != null ? Number(body.timeoutMs) : 60_000;

        if (!preparedId) return sendJson(res, 400, { ok: false, error: "MISSING_PREPARED_ID" });
        if (!confirm) return sendJson(res, 400, { ok: false, error: "CONFIRM_REQUIRED" });

        // idempotency: if already executed, return stored signature
        const prior = executed.get(preparedId);
        if (prior) {
          return sendJson(res, 200, { ok: true, signature: prior.signature, idempotent: true });
        }

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
        const conn = new Connection(rpcUrl, { commitment });

        const traceId = item.traceId;
        const trace = new TraceStore(defaultW3rtDir());

        const decision = policy
          ? policy.decide({
              chain: "solana",
              network,
              action: normalizePolicyAction(String(item.action)),
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

        const raw = Buffer.from(item.txB64, "base64");
        const tx = VersionedTransaction.deserialize(raw);

        // Refresh blockhash right before sending to avoid "Blockhash not found" if it expired.
        const latest = await refreshTxBlockhash(conn, tx);
        // keep for optional confirmation wait
        item.recentBlockhash = latest.blockhash;
        item.lastValidBlockHeight = latest.lastValidBlockHeight;

        const extra = Array.isArray(item.extraSigners) ? item.extraSigners : [];
        const extraKps = extra.map((sk) => Keypair.fromSecretKey(sk));
        tx.sign([kp, ...extraKps]);

        const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
        trace.emit({ ts: Date.now(), type: "tx.submitted", runId: traceId, data: { signature: sig } });

        executed.set(preparedId, { signature: sig, ts: Date.now() });
        persistExecuted();

        if (waitForConfirmation) {
          const blockhash = item.recentBlockhash ?? (tx.message as any).recentBlockhash;
          const lastValidBlockHeight = item.lastValidBlockHeight;
          if (typeof blockhash === "string" && typeof lastValidBlockHeight === "number") {
            const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("CONFIRM_TIMEOUT")), Math.max(1, timeoutMs)));
            try {
              const conf: any = await Promise.race([
                conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, commitment),
                timeout,
              ]);
              trace.emit({ ts: Date.now(), type: "tx.confirmed", runId: traceId, data: { signature: sig, value: conf.value } });
              prepared.delete(preparedId);
              return sendJson(res, 200, { ok: true, signature: sig, traceId, policyReport: decision, confirmation: conf.value });
            } catch (e: any) {
              prepared.delete(preparedId);
              return sendJson(res, 200, { ok: true, signature: sig, traceId, policyReport: decision, confirmation: { err: "CONFIRM_TIMEOUT_OR_ERROR", message: String(e?.message ?? e) } });
            }
          }
        }

        prepared.delete(preparedId);
        return sendJson(res, 200, { ok: true, signature: sig, traceId, policyReport: decision });
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

      const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const MAX_USDC_BASE_UNITS = 100 * 1_000_000;

      function exceedsDefaultUsdcLimit(a: { action?: string; params?: any }): boolean {
        const action = String(a?.action ?? "").toLowerCase();
        const p = (a?.params ?? {}) as any;

        // Only enforce a hard cap when we can confidently interpret the amount as USDC.
        const isUsdcMint = (m: any) => String(m ?? "") === USDC_MINT;

        // swap: if inputMint is USDC and amount is base units
        if (action.includes("swap") && isUsdcMint(p.inputMint)) {
          const amt = Number(p.amount);
          if (Number.isFinite(amt) && amt > MAX_USDC_BASE_UNITS) return true;
        }

        // transfers / deposits using amountBase (base units)
        if ((action.includes("transfer") || action.includes("deposit")) && (isUsdcMint(p.mint) || isUsdcMint(p.tokenMint) || isUsdcMint(p.stableMint))) {
          const amt = Number(p.amountBase ?? p.amount);
          if (Number.isFinite(amt) && amt > MAX_USDC_BASE_UNITS) return true;
        }

        return false;
      }

      class HttpError extends Error {
        status: number;
        bodyText: string;
        constructor(status: number, bodyText: string) {
          super(`HTTP ${status}: ${bodyText}`);
          this.status = status;
          this.bodyText = bodyText;
        }
      }

      // Global lightweight fetch rate limiter (token bucket)
      const HTTP_RPS = Math.max(0, Number(process.env.W3RT_HTTP_RPS ?? 0)); // 0 = disabled
      const HTTP_BURST = Math.max(1, Number(process.env.W3RT_HTTP_BURST ?? 8));
      let httpTokens = HTTP_RPS > 0 ? HTTP_BURST : 0;
      let httpLastRefill = Date.now();

      async function acquireHttpToken(): Promise<void> {
        if (HTTP_RPS <= 0) return;
        while (true) {
          const now = Date.now();
          const elapsed = Math.max(0, now - httpLastRefill);
          if (elapsed > 0) {
            const refill = (elapsed / 1000) * HTTP_RPS;
            if (refill >= 1) {
              httpTokens = Math.min(HTTP_BURST, httpTokens + Math.floor(refill));
              httpLastRefill = now;
            }
          }
          if (httpTokens > 0) {
            httpTokens--;
            return;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
      }

      function isRetryableHttpError(e: any): boolean {
        if (isTimeoutError(e)) return true;
        const status = Number((e as any)?.status);
        if (status === 429) return true;
        // retry transient upstreams
        if (status >= 500 && status <= 599) return true;
        return false;
      }

      async function fetchJsonWithRetry(url: URL | string, opts: {
        method?: string;
        headers?: Record<string, string>;
        body?: any;
        timeoutMs?: number;
        retries?: number;
        retryDelayMs?: number;
      }): Promise<any> {
        const {
          method = "GET",
          headers,
          body,
          timeoutMs = 12_000,
          retries = 2,
          retryDelayMs = 400,
        } = opts;

        let lastErr: any;
        for (let attempt = 0; attempt <= retries; attempt++) {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), timeoutMs);
          try {
            await acquireHttpToken();
            const res = await fetch(url, {
              method,
              headers,
              body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body),
              signal: ctrl.signal,
            });
            const text = await res.text();
            if (!res.ok) throw new HttpError(res.status, text);
            return text ? JSON.parse(text) : null;
          } catch (e: any) {
            lastErr = e;
            clearTimeout(timer);
            if (attempt >= retries || !isRetryableHttpError(e)) throw e;
            const base = retryDelayMs * Math.pow(2, attempt);
            const jitter = 0.5 + Math.random();
            const wait = Math.round(base * jitter);
            await new Promise((r) => setTimeout(r, wait));
          } finally {
            clearTimeout(timer);
          }
        }
        throw lastErr;
      }

      async function resolveSwapExactInJupiter(params: any): Promise<{ ok: boolean; quote?: any; error?: string; message?: string }> {
        const base = process.env.W3RT_JUPITER_BASE_URL || "https://api.jup.ag";
        const apiKey = process.env.W3RT_JUPITER_API_KEY;

        const inputMint = String(params.inputMint);
        const outputMint = String(params.outputMint);
        const amount = String(params.amount);
        const slippageBps = Number(params.slippageBps);

        const quoteUrl = new URL("/swap/v1/quote", base);
        quoteUrl.searchParams.set("inputMint", inputMint);
        quoteUrl.searchParams.set("outputMint", outputMint);
        quoteUrl.searchParams.set("amount", amount);
        quoteUrl.searchParams.set("slippageBps", String(slippageBps));

        try {
          const quote = await fetchJsonWithRetry(quoteUrl.toString(), {
            headers: apiKey ? { "x-api-key": apiKey } : undefined,
          });
          recordAdapterEvent("jupiter", "ok");
          return { ok: true, quote };
        } catch (e: any) {
          // If an (optional) API key/base is misconfigured, fall back to public Jupiter.
          const msg = String(e?.message ?? e);
          if (msg.includes("HTTP 401") || msg.toLowerCase().includes("unauthorized")) {
            try {
              const publicBase = "https://api.jup.ag";
              const u = new URL("/swap/v1/quote", publicBase);
              u.searchParams.set("inputMint", inputMint);
              u.searchParams.set("outputMint", outputMint);
              u.searchParams.set("amount", amount);
              u.searchParams.set("slippageBps", String(slippageBps));
              const quote = await fetchJsonWithRetry(u.toString(), { headers: undefined });
              recordAdapterEvent("jupiter", "ok");
              return { ok: true, quote };
            } catch (e2: any) {
              recordAdapterEvent("jupiter", is429Error(e2) ? "429" : isTimeoutError(e2) ? "timeout" : "fail");
              return { ok: false, error: "QUOTE_FAILED", message: String(e2?.message ?? e2) };
            }
          }
          recordAdapterEvent("jupiter", is429Error(e) ? "429" : isTimeoutError(e) ? "timeout" : "fail");
          return { ok: false, error: "QUOTE_FAILED", message: msg };
        }
      }

      type AdapterEventKind = "ok" | "fail" | "429" | "timeout";
      type AdapterEvent = { ts: number; kind: AdapterEventKind };

      const RESOLVE_STATS_WINDOW = 20;
      const adapterResolveStats = new Map<string, AdapterEvent[]>();

      // Simple circuit-breaker cooldown to protect RPC under sustained 429/timeout.
      const ADAPTER_COOLDOWN_MS = Math.max(0, Number(process.env.W3RT_ADAPTER_COOLDOWN_MS ?? 2500));
      const adapterBackoffUntil = new Map<string, number>();

      function inAdapterBackoff(adapter: string): boolean {
        if (ADAPTER_COOLDOWN_MS <= 0) return false;
        const until = adapterBackoffUntil.get(String(adapter)) ?? 0;
        return until > Date.now();
      }

      function snapshotAdapterBackoff() {
        const now = Date.now();
        const out: Record<string, any> = {};
        for (const [a, until] of adapterBackoffUntil.entries()) {
          out[a] = {
            inBackoff: until > now,
            backoffUntilMs: until,
            remainingMs: Math.max(0, until - now),
          };
        }
        metrics.adapterBackoff = out;
      }

      function tripAdapterBackoff(adapter: string, kind: AdapterEventKind) {
        if (ADAPTER_COOLDOWN_MS <= 0) return;
        // only trip on the expensive failure modes
        if (kind !== "429" && kind !== "timeout") return;
        adapterBackoffUntil.set(String(adapter), Date.now() + ADAPTER_COOLDOWN_MS);
      }

      // Quote concurrency limiter (reduce RPC spikes under load)
      const QUOTE_CONCURRENCY = Math.max(1, Number(process.env.W3RT_QUOTE_CONCURRENCY ?? 2));
      let quoteInFlight = 0;
      const quoteQueue: Array<() => void> = [];

      async function withQuoteSlot<T>(fn: () => Promise<T>): Promise<T> {
        if (QUOTE_CONCURRENCY <= 0) return await fn();
        if (quoteInFlight >= QUOTE_CONCURRENCY) {
          await new Promise<void>((resolve) => quoteQueue.push(resolve));
        }
        quoteInFlight++;
        try {
          return await fn();
        } finally {
          quoteInFlight = Math.max(0, quoteInFlight - 1);
          const next = quoteQueue.shift();
          if (next) next();
        }
      }

      function is429Error(e: any): boolean {
        const status = Number((e as any)?.status);
        if (status === 429) return true;
        const msg = String(e?.message ?? e);
        return msg.includes("429") || msg.toLowerCase().includes("too many requests");
      }

      function isTimeoutError(e: any): boolean {
        const msg = String(e?.message ?? e);
        return msg.toLowerCase().includes("timeout") || msg.includes("AbortError") || msg.includes("aborted") || msg.includes("ETIMEDOUT");
      }

      function recordAdapterEvent(adapter: string, kind: AdapterEventKind) {
        const a = String(adapter);
        const arr = adapterResolveStats.get(a) ?? [];
        arr.push({ ts: Date.now(), kind });
        while (arr.length > RESOLVE_STATS_WINDOW) arr.shift();
        adapterResolveStats.set(a, arr);

        // trip short backoff on 429/timeout
        tripAdapterBackoff(a, kind);

        // metrics
        const m = (metrics.adapters[a] = metrics.adapters[a] ?? { ok: 0, fail: 0, r429: 0, timeout: 0 });
        if (kind === "ok") m.ok++;
        else if (kind === "429") m.r429++;
        else if (kind === "timeout") m.timeout++;
        else m.fail++;
      }

      function computeStabilityPenaltyBps(adapter: string): number {
        const arr = adapterResolveStats.get(String(adapter)) ?? [];
        if (!arr.length) return 0;

        let ok = 0,
          fail = 0,
          tooMany = 0,
          timeout = 0;
        for (const e of arr) {
          if (e.kind === "ok") ok++;
          else if (e.kind === "429") tooMany++;
          else if (e.kind === "timeout") timeout++;
          else fail++;
        }
        const n = arr.length;

        // Penalty heuristic (0..200 bps): failures penalize, 429/timeout penalize more.
        const bad = fail + 2 * tooMany + 2 * timeout;
        const bps = Math.round((bad / Math.max(1, n)) * 200);
        return Math.max(0, Math.min(200, bps));
      }

      function computeEffectiveOut(q: any): bigint {
        const minOut = q?.minOutAmount;
        const out = q?.outAmount;
        const chosen = minOut != null ? String(minOut) : String(out ?? "0");
        try {
          return BigInt(chosen);
        } catch {
          return 0n;
        }
      }

      function applyPenalty(out: bigint, penaltyBps: number): bigint {
        const p = BigInt(Math.max(0, Math.min(10_000, 10_000 - penaltyBps)));
        return (out * p) / 10_000n;
      }

      async function withRetry<T>(fn: () => Promise<T>, opts: { retries?: number; baseDelayMs?: number } = {}): Promise<T> {
        const retries = opts.retries ?? 3;
        const baseDelayMs = opts.baseDelayMs ?? 500;
        let lastErr: any;
        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            return await fn();
          } catch (e: any) {
            lastErr = e;
            if (attempt >= retries || !is429Error(e)) throw e;
            const wait = baseDelayMs * Math.pow(2, attempt);
            await new Promise((r) => setTimeout(r, wait));
          }
        }
        throw lastErr;
      }

      async function resolveSwapExactInMeteora(params: any, ctx: { userPublicKey: string; rpcUrl: string }): Promise<{ ok: boolean; quote?: any; error?: string; message?: string }> {
        try {
          const out = await withRetry(
            () =>
              defaultRegistry.get("meteora").buildTx(
                "meteora.dlmm.swap_exact_in",
                {
                  inputMint: String(params.inputMint),
                  outputMint: String(params.outputMint),
                  amount: String(params.amount),
                  slippageBps: Number(params.slippageBps),
                },
                ctx
              ),
            { retries: 4, baseDelayMs: 500 }
          );

          const inAmount = out?.meta?.amounts?.inAmount;
          const outAmount = out?.meta?.amounts?.outAmount;
          if (!outAmount) throw new Error("Meteora quote missing outAmount");

          recordAdapterEvent("meteora", "ok");
          return {
            ok: true,
            quote: {
              inputMint: out.meta?.mints?.inputMint,
              outputMint: out.meta?.mints?.outputMint,
              inAmount,
              outAmount,
            },
          };
        } catch (e: any) {
          const kind: AdapterEventKind = is429Error(e) ? "429" : isTimeoutError(e) ? "timeout" : "fail";
          recordAdapterEvent("meteora", kind);
          return { ok: false, error: "QUOTE_FAILED", message: String(e?.message ?? e) };
        }
      }

      async function resolveSwapExactInRaydium(params: any, ctx: { userPublicKey: string; rpcUrl: string }): Promise<{ ok: boolean; quote?: any; error?: string; message?: string }> {
        try {
          const out = await withRetry(
            () =>
              defaultRegistry.get("raydium").buildTx(
                "raydium.clmm.swap_exact_in",
                {
                  inputMint: String(params.inputMint),
                  outputMint: String(params.outputMint),
                  amount: String(params.amount),
                  slippageBps: Number(params.slippageBps),
                },
                ctx
              ),
            { retries: 4, baseDelayMs: 700 }
          );

          const inAmount = out?.meta?.amounts?.inAmount;
          const outAmount = (out as any)?.meta?.amounts?.outAmount;
          const minOutAmount = (out as any)?.meta?.amounts?.minOutAmount;
          if (!minOutAmount && !outAmount) throw new Error("Raydium quote missing outAmount/minOutAmount");

          recordAdapterEvent("raydium", "ok");
          return {
            ok: true,
            quote: {
              inputMint: out.meta?.mints?.inputMint,
              outputMint: out.meta?.mints?.outputMint,
              inAmount,
              // Prefer expected outAmount if available; fall back to conservative minOut.
              outAmount: String(outAmount ?? minOutAmount),
              kind: outAmount ? "expectedOut" : "minOut",
              minOutAmount: minOutAmount != null ? String(minOutAmount) : undefined,
            },
          };
        } catch (e: any) {
          const kind: AdapterEventKind = is429Error(e) ? "429" : isTimeoutError(e) ? "timeout" : "fail";
          recordAdapterEvent("raydium", kind);
          return { ok: false, error: "QUOTE_FAILED", message: String(e?.message ?? e) };
        }
      }

      // Workflow v0: resolve chain-agnostic intents into concrete adapter actions.
      // POST /v1/workflows/resolve_v0
      // Body: { intents: [...] }

      function resolveCacheKey(intent: any): string {
        const p = intent?.params ?? {};
        return [
          String(intent?.chain ?? "solana"),
          String(intent?.type ?? ""),
          String(p.inputMint ?? ""),
          String(p.outputMint ?? ""),
          String(p.amount ?? ""),
          String(p.slippageBps ?? ""),
        ].join("|");
      }
      if (req.method === "POST" && url.pathname === "/v1/workflows/resolve_v0") {
        const t0 = Date.now();
        let okReq = false;
        try {
          const body = await readJsonBody(req);
        const intents = Array.isArray(body?.intents) ? body.intents : [];
        if (!intents.length) return sendJson(res, 400, { ok: false, error: "MISSING_INTENTS" });

        const outQuotes: any[] = [];
        const resolvedActions: any[] = [];

        for (const it of intents) {
          const id = String(it?.id ?? `i_${crypto.randomUUID().slice(0, 8)}`);
          const chain = String(it?.chain ?? "solana");
          const type = String(it?.type ?? "");
          const params = it?.params ?? {};

          if (chain !== "solana") {
            outQuotes.push({ id, ok: false, error: "UNSUPPORTED_CHAIN", chain });
            continue;
          }

          if (type !== "swap_exact_in") {
            outQuotes.push({ id, ok: false, error: "UNSUPPORTED_INTENT", type });
            continue;
          }

          // Cache check (best-effort)
          const key = resolveCacheKey({ chain, type, params });
          if (RESOLVE_CACHE_TTL_MS > 0) {
            const hit = resolveCache.get(key);
            if (hit && Date.now() - hit.ts < RESOLVE_CACHE_TTL_MS) {
              // Expand cached results with this request's id
              const cached = hit.value;
              for (const q of cached.quotes ?? []) outQuotes.push({ ...q, id, cacheHit: true });
              for (const a of cached.resolvedActions ?? []) resolvedActions.push({ ...a, id });
              continue;
            }
          }

          // Phase 2: try Jupiter, then compare Meteora vs Raydium (best-effort outAmount).
          const kp = loadSolanaKeypair();
          if (!kp) {
            outQuotes.push({ id, ok: false, error: "MISSING_SOLANA_KEYPAIR" });
            continue;
          }
          const rpcUrl = resolveSolanaRpc();
          const ctx = { userPublicKey: kp.publicKey.toBase58(), rpcUrl };

          const qJ = inAdapterBackoff("jupiter")
            ? { ok: false, quote: undefined, error: "ADAPTER_BACKOFF", message: "jupiter temporarily backed off due to 429/timeout" }
            : await withQuoteSlot(() => resolveSwapExactInJupiter(params));
          const jupEff = qJ.ok ? (() => { try { return BigInt(String(qJ.quote?.outAmount ?? "0")); } catch { return 0n; } })() : 0n;
          const jupPenalty = computeStabilityPenaltyBps("jupiter");
          const jupScore = applyPenalty(jupEff, jupPenalty);

          outQuotes.push({
            id,
            adapter: "jupiter",
            ok: qJ.ok,
            quote: qJ.quote,
            confidence: qJ.ok ? "high" : "low",
            explain: qJ.ok
              ? "Jupiter is an aggregator quote (high confidence)"
              : "Jupiter quote failed (often due to missing/invalid API key or base URL)",
            effectiveOut: jupEff.toString(),
            stabilityPenaltyBps: jupPenalty,
            scoreOut: jupScore.toString(),
            cacheHit: false,
            error: qJ.error,
            message: qJ.message,
          });

          // If Jupiter works, use it (it is already an aggregate router).
          if (qJ.ok) {
            const act = {
              id,
              dependsOn: Array.isArray(it?.dependsOn) ? it.dependsOn : [],
              chain: "solana",
              adapter: "jupiter",
              action: "solana.swap_exact_in",
              params,
              resolvedFrom: {
                type,
                chosen: "jupiter",
                scoring: "aggregator",
                scoringBreakdown: {
                  effectiveOut: jupEff.toString(),
                  stabilityPenaltyBps: jupPenalty,
                  scoreOut: jupScore.toString(),
                },
              },
            };
            resolvedActions.push(act);

            // Write cache entry
            if (RESOLVE_CACHE_TTL_MS > 0) {
              resolveCache.set(key, {
                ts: Date.now(),
                value: {
                  quotes: [{ ...outQuotes[outQuotes.length - 1], id: "__ID__", cacheHit: false }],
                  resolvedActions: [{ ...act, id: "__ID__" }],
                },
              });
            }

            continue;
          }

          const meteoraBackoff = inAdapterBackoff("meteora");
          const raydiumBackoff = inAdapterBackoff("raydium");

          const [qM, qR] = await Promise.all([
            meteoraBackoff
              ? Promise.resolve({ ok: false, quote: undefined, error: "ADAPTER_BACKOFF", message: "meteora temporarily backed off due to 429/timeout" })
              : withQuoteSlot(() => resolveSwapExactInMeteora(params, ctx)),
            raydiumBackoff
              ? Promise.resolve({ ok: false, quote: undefined, error: "ADAPTER_BACKOFF", message: "raydium temporarily backed off due to 429/timeout" })
              : withQuoteSlot(() => resolveSwapExactInRaydium(params, ctx)),
          ]);

          const quotesForCache: any[] = [];
          const actionsForCache: any[] = [];

          const meteoraEff = qM.ok ? computeEffectiveOut(qM.quote) : 0n;
          const meteoraPenalty = computeStabilityPenaltyBps("meteora");
          const meteoraScore = applyPenalty(meteoraEff, meteoraPenalty);

          const raydiumEff = qR.ok ? computeEffectiveOut(qR.quote) : 0n;
          const raydiumPenalty = computeStabilityPenaltyBps("raydium");
          const raydiumScore = applyPenalty(raydiumEff, raydiumPenalty);

          const qmOut = {
            id,
            adapter: "meteora",
            ok: qM.ok,
            quote: qM.quote,
            confidence: qM.ok ? "high" : "low",
            explain: qM.ok ? "Meteora DLMM quote derived from on-chain pool state" : "Meteora quote failed",
            effectiveOut: meteoraEff.toString(),
            stabilityPenaltyBps: meteoraPenalty,
            scoreOut: meteoraScore.toString(),
            cacheHit: false,
            error: qM.error,
            message: qM.message,
          };
          const qrOut = {
            id,
            adapter: "raydium",
            ok: qR.ok,
            quote: qR.quote,
            confidence: qR.ok ? (qR.quote?.kind === "expectedOut" ? "medium" : "low") : "low",
            explain: qR.ok
              ? (qR.quote?.kind === "expectedOut"
                  ? "Raydium CLMM quote computed from tick arrays; expectedOut may drift, minOut is safety bound"
                  : "Raydium quote uses conservative minOut")
              : "Raydium quote failed (often RPC 429 / pool fetch)",
            effectiveOut: raydiumEff.toString(),
            stabilityPenaltyBps: raydiumPenalty,
            scoreOut: raydiumScore.toString(),
            cacheHit: false,
            error: qR.error,
            message: qR.message,
          };

          outQuotes.push(qmOut);
          outQuotes.push(qrOut);
          quotesForCache.push({ ...qmOut, id: "__ID__" });
          quotesForCache.push({ ...qrOut, id: "__ID__" });

          const candidates = [
            qM.ok ? { adapter: "meteora", action: "meteora.dlmm.swap_exact_in", q: qM.quote } : null,
            qR.ok ? { adapter: "raydium", action: "raydium.clmm.swap_exact_in", q: qR.quote } : null,
          ].filter(Boolean) as any[];

          if (!candidates.length) continue;

          // Score by effectiveOut (prefer minOutAmount) + stability penalty.
          const scored = candidates.map((c) => {
            const effectiveOut = computeEffectiveOut(c.q);
            const penaltyBps = computeStabilityPenaltyBps(c.adapter);
            const scoreOut = applyPenalty(effectiveOut, penaltyBps);
            return { ...c, effectiveOut, penaltyBps, scoreOut };
          });

          scored.sort((a, b) => (b.scoreOut > a.scoreOut ? 1 : b.scoreOut < a.scoreOut ? -1 : 0));

          const chosen = scored[0];
          const act = {
            id,
            dependsOn: Array.isArray(it?.dependsOn) ? it.dependsOn : [],
            chain: "solana",
            adapter: chosen.adapter,
            action: chosen.action,
            params,
            resolvedFrom: {
              type,
              chosen: chosen.adapter,
              scoring: "effectiveOut_minus_stability_penalty",
              scoringBreakdown: {
                effectiveOut: chosen.effectiveOut.toString(),
                stabilityPenaltyBps: chosen.penaltyBps,
                scoreOut: chosen.scoreOut.toString(),
              },
            },
          };
          resolvedActions.push(act);

          // cache this resolution
          actionsForCache.push({ ...act, id: "__ID__" });
          if (RESOLVE_CACHE_TTL_MS > 0) {
            resolveCache.set(key, { ts: Date.now(), value: { quotes: quotesForCache, resolvedActions: actionsForCache } });
          }
        }

        const chosen = resolvedActions.map((a) => ({
          id: a.id,
          adapter: a.adapter,
          action: a.action,
          scoring: a?.resolvedFrom?.scoring ?? (a.adapter === "jupiter" ? "aggregator" : "maxOutAmount"),
          scoringBreakdown: a?.resolvedFrom?.scoringBreakdown ?? null,
        }));

        okReq = true;
        const resp = {
          ok: true,
          intentsCount: intents.length,
          quotes: outQuotes,
          resolvedActions,
          chosen,
          explain: "Resolver picks Jupiter when available; otherwise compares venues by effectiveOut (prefer minOut) with a stability penalty.",
        };
        return sendJson(res, 200, resp);
      } finally {
        observeRequest("resolve_v0", Date.now() - t0, okReq);
      }
      }

      // Workflow v0: single entrypoint that compiles a deterministic plan into prepared artifacts.
      // POST /v1/workflows/run_v0
      // Body: { plan: { actions: [...] } } (or { actions: [...] }) OR { intents: [...] }
      if (req.method === "POST" && url.pathname === "/v1/workflows/run_v0") {
        const t0 = Date.now();
        let okReq = false;
        try {
          const body = await readJsonBody(req);

        // Accept chain-agnostic intents and resolve them first (phase 1: Jupiter only)
        let actions = normalizeActions(body.actions ?? body.plan?.actions ?? body.plan?.steps);
        let resolveInfo: any = null;
        if ((!actions || !actions.length) && Array.isArray(body?.intents) && body.intents.length) {
          const intents = body.intents;
          const quotes: any[] = [];
          const resolved: any[] = [];

          for (const it of intents) {
            const id = String(it?.id ?? `i_${crypto.randomUUID().slice(0, 8)}`);
            const chain = String(it?.chain ?? "solana");
            const type = String(it?.type ?? "");
            const params = it?.params ?? {};

            if (chain !== "solana" || type !== "swap_exact_in") {
              quotes.push({ id, ok: false, error: chain !== "solana" ? "UNSUPPORTED_CHAIN" : "UNSUPPORTED_INTENT", chain, type });
              continue;
            }

            const kp = loadSolanaKeypair();
            if (!kp) {
              quotes.push({ id, ok: false, error: "MISSING_SOLANA_KEYPAIR" });
              continue;
            }
            const rpcUrl = resolveSolanaRpc();
            const ctx = { userPublicKey: kp.publicKey.toBase58(), rpcUrl };

            const qJ = inAdapterBackoff("jupiter")
              ? { ok: false, quote: undefined, error: "ADAPTER_BACKOFF", message: "jupiter temporarily backed off due to 429/timeout" }
              : await withQuoteSlot(() => resolveSwapExactInJupiter(params));
            const jupEff = qJ.ok ? (() => { try { return BigInt(String(qJ.quote?.outAmount ?? "0")); } catch { return 0n; } })() : 0n;
            const jupPenalty = computeStabilityPenaltyBps("jupiter");
            const jupScore = applyPenalty(jupEff, jupPenalty);

            quotes.push({
              id,
              adapter: "jupiter",
              ok: qJ.ok,
              quote: qJ.quote,
              confidence: qJ.ok ? "high" : "low",
              explain: qJ.ok
                ? "Jupiter is an aggregator quote (high confidence)"
                : "Jupiter quote failed (often due to missing/invalid API key or base URL)",
              effectiveOut: jupEff.toString(),
              stabilityPenaltyBps: jupPenalty,
              scoreOut: jupScore.toString(),
              error: qJ.error,
              message: qJ.message,
            });

            if (qJ.ok) {
              resolved.push({
                id,
                dependsOn: Array.isArray(it?.dependsOn) ? it.dependsOn : [],
                chain: "solana",
                adapter: "jupiter",
                action: "solana.swap_exact_in",
                params,
                resolvedFrom: {
                  type,
                  chosen: "jupiter",
                  scoring: "aggregator",
                  scoringBreakdown: {
                    effectiveOut: jupEff.toString(),
                    stabilityPenaltyBps: jupPenalty,
                    scoreOut: jupScore.toString(),
                  },
                },
              });
              continue;
            }

            const [qM, qR] = await Promise.all([
              resolveSwapExactInMeteora(params, ctx),
              resolveSwapExactInRaydium(params, ctx),
            ]);

            const meteoraEff = qM.ok ? computeEffectiveOut(qM.quote) : 0n;
            const meteoraPenalty = computeStabilityPenaltyBps("meteora");
            const meteoraScore = applyPenalty(meteoraEff, meteoraPenalty);

            const raydiumEff = qR.ok ? computeEffectiveOut(qR.quote) : 0n;
            const raydiumPenalty = computeStabilityPenaltyBps("raydium");
            const raydiumScore = applyPenalty(raydiumEff, raydiumPenalty);

            quotes.push({
              id,
              adapter: "meteora",
              ok: qM.ok,
              quote: qM.quote,
              confidence: qM.ok ? "high" : "low",
              explain: qM.ok ? "Meteora DLMM quote derived from on-chain pool state" : "Meteora quote failed",
              effectiveOut: meteoraEff.toString(),
              stabilityPenaltyBps: meteoraPenalty,
              scoreOut: meteoraScore.toString(),
              error: qM.error,
              message: qM.message,
            });
            quotes.push({
              id,
              adapter: "raydium",
              ok: qR.ok,
              quote: qR.quote,
              confidence: qR.ok ? (qR.quote?.kind === "expectedOut" ? "medium" : "low") : "low",
              explain: qR.ok
                ? (qR.quote?.kind === "expectedOut"
                    ? "Raydium CLMM quote computed from tick arrays; expectedOut may drift, minOut is safety bound"
                    : "Raydium quote uses conservative minOut")
                : "Raydium quote failed (often RPC 429 / pool fetch)",
              effectiveOut: raydiumEff.toString(),
              stabilityPenaltyBps: raydiumPenalty,
              scoreOut: raydiumScore.toString(),
              error: qR.error,
              message: qR.message,
            });

            const candidates = [
              qM.ok ? { adapter: "meteora", action: "meteora.dlmm.swap_exact_in", q: qM.quote } : null,
              qR.ok ? { adapter: "raydium", action: "raydium.clmm.swap_exact_in", q: qR.quote } : null,
            ].filter(Boolean) as any[];

            if (!candidates.length) continue;

            const scored = candidates.map((c) => {
              const effectiveOut = computeEffectiveOut(c.q);
              const penaltyBps = computeStabilityPenaltyBps(c.adapter);
              const scoreOut = applyPenalty(effectiveOut, penaltyBps);
              return { ...c, effectiveOut, penaltyBps, scoreOut };
            });

            scored.sort((a, b) => (b.scoreOut > a.scoreOut ? 1 : b.scoreOut < a.scoreOut ? -1 : 0));

            const chosen = scored[0];
            resolved.push({
              id,
              dependsOn: Array.isArray(it?.dependsOn) ? it.dependsOn : [],
              chain: "solana",
              adapter: chosen.adapter,
              action: chosen.action,
              params,
              resolvedFrom: {
                type,
                chosen: chosen.adapter,
                scoring: "effectiveOut_minus_stability_penalty",
                scoringBreakdown: {
                  effectiveOut: chosen.effectiveOut.toString(),
                  stabilityPenaltyBps: chosen.penaltyBps,
                  scoreOut: chosen.scoreOut.toString(),
                },
              },
            });
          }

          resolveInfo = {
            intentsCount: intents.length,
            quotes,
            resolvedActions: resolved,
            chosen: resolved.map((a) => ({ id: a.id, adapter: a.adapter, action: a.action, scoring: a?.resolvedFrom?.scoring ?? null, scoringBreakdown: a?.resolvedFrom?.scoringBreakdown ?? null })),
          };
          actions = normalizeActions(resolved);
        }

        if (!actions.length) return sendJson(res, 400, { ok: false, error: "MISSING_ACTIONS" });

        const { ordered, cycles } = topoOrderActions(actions);
        if (cycles.length) return sendJson(res, 400, { ok: false, error: "PLAN_CYCLE", cycles });

        const kp = loadSolanaKeypair();
        if (!kp) return sendJson(res, 400, { ok: false, error: "MISSING_SOLANA_KEYPAIR" });

        const rpcUrl = resolveSolanaRpc();
        const network = inferNetworkFromRpcUrl(rpcUrl);

        // v0 safety baseline: mainnet + explicit confirm required for any broadcast (enforced in /v1/actions/execute).
        // v0 risk baseline: single-step cap at 100 USDC when amount is clearly USDC.

        const traceId = crypto.randomUUID();
        const runId = traceId;
        const trace = new TraceStore(w3rtDir);
        trace.emit({ ts: Date.now(), type: "run.started", runId, data: { mode: "workflow.v0", network, count: ordered.length } });

        // Initialize run status
        writeRunStatus(runId, { status: "preparing", network, steps: {} });

        const runDir = join(w3rtDir, "runs", runId);
        mkdirSync(runDir, { recursive: true });

        // Persist resolve info (if run started from chain-agnostic intents)
        if (resolveInfo) {
          try {
            writeFileSync(join(runDir, "resolve.json"), JSON.stringify({ ok: true, runId, network, ...resolveInfo }, null, 2));
          } catch {
            // best-effort
          }
        }

        // Persist input plan
        try {
          writeFileSync(join(runDir, "plan.json"), JSON.stringify({ ok: true, runId, network, actions: ordered }, null, 2));
        } catch {
          // best-effort
        }

        const drivers = makeDriverRegistry(rpcUrl);
        const results: any[] = [];
        const resultById = new Map<string, any>();

        for (const [idx, a] of ordered.entries()) {
          const id = String(a.id);
          const adapter = String(a.adapter || "");
          const action = String(a.action || "");
          const params = (a.params ?? {}) as Dict;
          const chain = String(a.chain || "solana");
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

          // v0 hard cap (best-effort)
          if (exceedsDefaultUsdcLimit({ action, params })) {
            const r = {
              ok: false,
              id,
              error: "RISK_LIMIT_EXCEEDED",
              message: "Default risk limit exceeded (100 USDC per step)",
              limit: { usdc: 100 },
              adapter,
              action,
              params,
              allowed: false,
              requiresApproval: false,
              policyReport: { decision: "block", reason: "usdc_limit" },
            };
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

          let built: any;
          try {
            built = await defaultRegistry.get(adapter).buildTx(action, params, {
              userPublicKey: kp.publicKey.toBase58(),
              rpcUrl,
            });
          } catch (e: any) {
            const r = {
              ok: false,
              id,
              error: "BUILD_FAILED",
              adapter,
              action,
              message: String(e?.message ?? e),
              summary: {
                kind: String(action).includes("swap") ? "swap" : String(action).includes("transfer") ? "transfer" : "unknown",
                chain,
                stepId: id,
                adapter,
                action,
                inputMint: params?.inputMint ?? null,
                outputMint: params?.outputMint ?? null,
                inAmount: params?.amount ?? null,
                slippageBps: params?.slippageBps ?? null,
              },
            };
            results.push(r);
            resultById.set(id, r);

            writeRunStatus(runId, {
              status: "failed",
              steps: {
                [id]: {
                  id,
                  adapter,
                  action,
                  state: "failed",
                  error: r.error,
                  message: r.message,
                  summary: r.summary,
                },
              },
            });

            continue;
          }

          const txB64 = built.txB64;
          const extraSigners = (built as any).signers as Uint8Array[] | undefined;

          const simulation = await driver.simulateTxB64(txB64, { rpcUrl });
          const { ids: programIds, known } = await driver.extractIdsFromTxB64(txB64, { rpcUrl });

          const decision = policy
            ? policy.decide({
                chain: "solana",
                network,
                action: normalizePolicyAction(String((built as any)?.meta?.action ?? action)),
                sideEffect: "none",
                simulationOk: simulation.ok,
                programIdsKnown: known,
                programIds,
              } as any)
            : { decision: "allow" };

          const requiresApproval = true; // v0: any funds-moving step must be explicitly confirmed by user
          const allowed = decision.decision === "allow" || decision.decision === "confirm";

          const preparedId = `prep_${crypto.randomUUID().slice(0, 16)}`;
          const now = Date.now();

          const artifact = {
            chain,
            adapter,
            action: String((built as any)?.meta?.action ?? action),
            params,
            txB64,
            simulation,
            programIds,
            policy: { decision: decision.decision },
            traceId: runId,
            preparedId,
          };
          const hash = computeArtifactHash(artifact);

          const parsed = safeParseTx(txB64);

          prepared.set(preparedId, {
            preparedId,
            createdAt: now,
            expiresAt: now + ttlMs,
            traceId: runId,
            chain: "solana",
            adapter,
            action: String((built as any)?.meta?.action ?? action),
            params,
            txB64,
            recentBlockhash: parsed?.recentBlockhash,
            extraSigners,
            simulation,
            programIds,
            programIdsKnown: known,
            network,
            artifactSchemaVersion: hash.schemaVersion,
            hashAlg: hash.hashAlg,
            artifactHash: hash.artifactHash,
            artifactCanonicalJson: hash.canonicalJson,
          });

          // Human-friendly confirmation summary (best-effort)
          const meta: any = built.meta ?? {};
          const mints = meta?.mints ?? {};
          const amounts = meta?.amounts ?? {};

          // If this run originated from intents, attach resolver context.
          const resolverQuote = resolveInfo?.quotes
            ? (resolveInfo.quotes as any[]).find((q) => q && q.id === id && q.adapter === String(meta?.adapter ?? adapter))
            : null;
          const resolverChosen = resolveInfo?.chosen
            ? (resolveInfo.chosen as any[]).find((c) => c && c.id === id)
            : null;

          const summary = {
            kind: String(action).includes("swap") ? "swap" : String(action).includes("transfer") ? "transfer" : "unknown",
            chain,
            stepId: id,
            adapter: String(meta?.adapter ?? adapter),
            action: String(meta?.action ?? action),
            inputMint: mints.inputMint ?? null,
            outputMint: mints.outputMint ?? null,
            inAmount: amounts.inAmount ?? params.amount ?? null,
            expectedOut: amounts.outAmount ?? amounts.outAmountBase ?? null,
            minOut: amounts.minOutAmount ?? null,
            slippageBps: meta.slippageBps ?? params.slippageBps ?? null,
            confidence: resolverQuote?.confidence ?? null,
            explain: resolverQuote?.explain ?? null,
            scoring: resolverChosen?.scoring ?? null,
            scoringBreakdown: resolverChosen?.scoringBreakdown ?? null,
          };

          const out = {
            ok: true,
            id,
            index: idx,
            dependsOn: deps,
            adapter,
            action: String((built as any)?.meta?.action ?? action),
            preparedId,
            allowed,
            requiresApproval,
            simulation,
            programIds,
            programIdsKnown: known,
            meta,
            summary,
            policyReport: decision,
            artifactSchemaVersion: hash.schemaVersion,
            hashAlg: hash.hashAlg,
            artifactHash: hash.artifactHash,
          };

          // Persist step status
          writeRunStatus(runId, {
            status: requiresApproval ? "needs_confirm" : "prepared",
            steps: {
              [id]: {
                id,
                adapter: String(meta?.adapter ?? adapter),
                action: String(meta?.action ?? action),
                preparedId,
                allowed,
                requiresApproval,
                simulationOk: simulation.ok === true,
                artifactHash: hash.artifactHash,
                summary,
                state: "prepared",
              },
            },
          });

          results.push(out);
          resultById.set(id, out);
        }

        trace.emit({ ts: Date.now(), type: "run.finished", runId, data: { ok: true } });

        try {
          writeFileSync(join(runDir, "simulate.json"), JSON.stringify({ ok: true, runId, results: results.map((r) => ({ id: r.id, simulation: r.simulation })) }, null, 2));
          writeFileSync(join(runDir, "policy.json"), JSON.stringify({ ok: true, runId, results: results.map((r) => ({ id: r.id, policyReport: r.policyReport, allowed: r.allowed, requiresApproval: r.requiresApproval })) }, null, 2));
          writeFileSync(join(runDir, "summary.json"), JSON.stringify({ ok: true, runId, summaries: results.filter((r) => r && r.ok).map((r) => r.summary) }, null, 2));
        } catch {
          // best-effort
        }

        const summaries = results.filter((r) => r && r.ok).map((r) => r.summary);

        okReq = true;
        const resp = { ok: true, runId, traceId: runId, order: ordered.map((a) => a.id), results, summaries, artifactsDir: runDir };
        return sendJson(res, 200, resp);
      } finally {
        observeRequest("run_v0", Date.now() - t0, okReq);
      }
      }

      // Workflow v0: explicit confirm/execute wrapper.
      // POST /v1/workflows/confirm_v0
      // Body: { preparedId, confirm:true } OR { runId, stepId, confirm:true }
      if (req.method === "POST" && url.pathname === "/v1/workflows/confirm_v0") {
        const t0 = Date.now();
        let okReq = false;
        try {
          const body = await readJsonBody(req);

        // Allow confirming by (runId, stepId) in addition to preparedId.
        let preparedId = String(body.preparedId || "");
        const runId = body.runId ? String(body.runId) : "";
        const stepId = body.stepId ? String(body.stepId) : "";

        // If already executed for this run+step, return idempotently.
        if (runId && stepId) {
          const status = loadRunStatus(runId);
          const step = status?.steps?.[stepId];
          const sig = step?.signature;
          if (typeof sig === "string" && sig.length > 20) {
            return sendJson(res, 200, { ok: true, signature: sig, traceId: runId, runId, idempotent: true });
          }
        }

        if (!preparedId && runId && stepId) {
          const status = loadRunStatus(runId);
          const pid = status?.steps?.[stepId]?.preparedId;
          if (pid) preparedId = String(pid);
        }

        const confirm = body.confirm === true;
        if (!preparedId) return sendJson(res, 400, { ok: false, error: "MISSING_PREPARED_ID", hint: "Provide preparedId or (runId + stepId)" });
        if (!confirm) return sendJson(res, 400, { ok: false, error: "CONFIRM_REQUIRED" });

        // Delegate to the existing execute path by reusing its semantics.
        (req as any).url = "/v1/actions/execute";
        (req as any).method = "POST";
        // We can't re-stream the body, so just call the execute handler logic directly by duplicating a minimal call.
        // (Fall back to the shared code path below if refactoring happens later.)
        const prior = executed.get(preparedId);
        if (prior) return sendJson(res, 200, { ok: true, signature: prior.signature, idempotent: true });

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

        const traceId = item.traceId;
        const trace = new TraceStore(defaultW3rtDir());

        const decision = policy
          ? policy.decide({
              chain: "solana",
              network,
              action: normalizePolicyAction(String(item.action)),
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

        const raw = Buffer.from(item.txB64, "base64");
        const tx = VersionedTransaction.deserialize(raw);
        await refreshTxBlockhash(conn, tx);

        const extra = Array.isArray(item.extraSigners) ? item.extraSigners : [];
        const extraKps = extra.map((sk) => Keypair.fromSecretKey(sk));
        tx.sign([kp, ...extraKps]);

        const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });

        executed.set(preparedId, { signature: sig, ts: Date.now() });
        persistExecuted();
        prepared.delete(preparedId);

        trace.emit({ ts: Date.now(), type: "step.finished", runId: traceId, stepId: "execute", data: { ok: true, signature: sig } });

        // Persist execute artifact (best-effort)
        try {
          const runDir = join(defaultW3rtDir(), "runs", traceId);
          mkdirSync(runDir, { recursive: true });
          writeFileSync(join(runDir, "execute.json"), JSON.stringify({ ok: true, runId: traceId, preparedId, signature: sig }, null, 2));
        } catch {
          // best-effort
        }

        // Update status.json if present
        try {
          const st = loadRunStatus(traceId);
          if (st && typeof st === "object") {
            const steps = st.steps ?? {};
            for (const [sid, s] of Object.entries(steps)) {
              if ((s as any)?.preparedId === preparedId) {
                writeRunStatus(traceId, {
                  status: "executed",
                  steps: { [sid]: { ...(s as any), state: "executed", signature: sig } },
                });
                break;
              }
            }
          }
        } catch {
          // best-effort
        }

        // After broadcast: best-effort confirm/poll and attach a compact tx summary
        let txStatus: any = null;
        try {
          const delays = [800, 1600, 3200];
          for (let i = 0; i < delays.length; i++) {
            await sleep(delays[i]);
            const st = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
            const v = st?.value?.[0] ?? null;
            if (v) {
              txStatus = { confirmationStatus: v.confirmationStatus ?? null, err: v.err ?? null, slot: v.slot ?? null };
              // stop early if finalized or failed
              if (v.err || v.confirmationStatus === "finalized") break;
            }
          }
        } catch {
          // ignore
        }

        // best-effort delta summary
        let txSummary: any = null;
        let receipt: any = null;
        try {
          txSummary = await getSolanaTxDeltaSummary(conn, sig);
          if (txSummary && txSummary.delta) {
            const owner = kp.publicKey.toBase58();
            const toks = Array.isArray(txSummary.delta.tokens) ? txSummary.delta.tokens : [];
            const mine = toks.filter((t: any) => String(t?.owner ?? "") === owner);
            const received = mine
              .filter((t: any) => Number(t?.uiDelta ?? 0) > 0)
              .sort((a: any, b: any) => Number(b.uiDelta) - Number(a.uiDelta));
            const spent = mine
              .filter((t: any) => Number(t?.uiDelta ?? 0) < 0)
              .sort((a: any, b: any) => Number(a.uiDelta) - Number(b.uiDelta));

            receipt = {
              owner,
              feeLamports: txSummary.delta.feeLamports ?? null,
              feeSol: typeof txSummary.delta.feeLamports === "number" ? txSummary.delta.feeLamports / 1_000_000_000 : null,
              spent: spent.slice(0, 3).map((t: any) => ({ mint: t.mint, uiDelta: t.uiDelta })),
              received: received.slice(0, 3).map((t: any) => ({ mint: t.mint, uiDelta: t.uiDelta })),
            };
          }
        } catch {
          // ignore
        }

        // Write a user-facing execution report (best-effort)
        try {
          const runDir = join(defaultW3rtDir(), "runs", traceId);
          mkdirSync(runDir, { recursive: true });
          const st = loadRunStatus(traceId);
          const steps = st?.steps ?? {};
          const reportSteps = Object.entries(steps).map(([sid, s]: any) => {
            const signature = s?.signature ?? null;
            return {
              stepId: sid,
              state: s?.state ?? null,
              adapter: s?.adapter ?? null,
              action: s?.action ?? null,
              preparedId: s?.preparedId ?? null,
              signature,
              explorerUrl: signature ? `https://solana.fm/tx/${signature}` : null,
              summary: s?.summary ?? null,
              error: s?.error ?? null,
              message: s?.message ?? null,
            };
          });

          const report = {
            ok: true,
            runId: traceId,
            status: st?.status ?? "executed",
            updatedAt: new Date().toISOString(),
            steps: reportSteps,
            txStatus,
            txSummary,
            receipt,
          };

          writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2));
        } catch {
          // best-effort
        }

        okReq = true;
        return sendJson(res, 200, {
          ok: true,
          signature: sig,
          traceId,
          runId: traceId,
          explorerUrl: `https://solana.fm/tx/${sig}`,
          txStatus,
          txSummary,
          receipt,
        });
      } finally {
        observeRequest("confirm_v0", Date.now() - t0, okReq);
      }
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
            const r = {
              ok: false,
              id,
              error: "BUILD_FAILED",
              adapter,
              action,
              message: String(e?.message ?? e),
              summary: {
                kind: String(action).includes("swap") ? "swap" : String(action).includes("transfer") ? "transfer" : "unknown",
                chain,
                stepId: id,
                adapter,
                action,
                inputMint: params?.inputMint ?? null,
                outputMint: params?.outputMint ?? null,
                inAmount: params?.amount ?? null,
                slippageBps: params?.slippageBps ?? null,
              },
            };
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
                action: normalizePolicyAction(action),
                sideEffect: "none",
                simulationOk: simulation.ok,
                programIdsKnown: known,
                programIds,
              } as any)
            : { decision: "allow" };

          // metrics: policy decision
          if ((metrics as any).policyDecisions && (metrics as any).policyDecisions[decision.decision] != null) {
            (metrics as any).policyDecisions[decision.decision]++;
          }

          const requiresApproval = decision.decision === "confirm";
          const allowed = decision.decision === "allow" || decision.decision === "confirm";

          const preparedId = `prep_${crypto.randomUUID().slice(0, 16)}`;
          const now = Date.now();

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
            artifactSchemaVersion: hash.schemaVersion,
            hashAlg: hash.hashAlg,
            artifactHash: hash.artifactHash,
            artifactCanonicalJson: hash.canonicalJson,
          });

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
            artifactSchemaVersion: hash.schemaVersion,
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
              action: normalizePolicyAction(String((built as any)?.meta?.action ?? action)),
              sideEffect: "none",
              simulationOk: simulation.ok,
              programIds,
              programIdsKnown: known,
            } as any)
          : { decision: "allow" };

        // metrics: policy decision
        if ((metrics as any).policyDecisions && (metrics as any).policyDecisions[decision.decision] != null) {
          (metrics as any).policyDecisions[decision.decision]++;
        }

        const requiresApproval = decision.decision === "confirm";
        const allowed = decision.decision === "allow" || decision.decision === "confirm";

        const preparedId = `prep_${crypto.randomUUID().slice(0, 16)}`;
        const now = Date.now();

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

        // capture blockhash (mostly for debugging)
        const parsed = safeParseTx(txB64);

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
          recentBlockhash: parsed?.recentBlockhash,
          extraSigners,
          simulation,
          programIds,
          programIdsKnown: known,
          network,
          artifactSchemaVersion: hash.schemaVersion,
          hashAlg: hash.hashAlg,
          artifactHash: hash.artifactHash,
          artifactCanonicalJson: hash.canonicalJson,
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

        // Local AgentMemory payload (best-effort). For now, we use artifactHash as the reasoning_hash placeholder.
        try {
          writeMemoryRecord(w3rtDir, {
            run_id: traceId,
            reasoning_hash: hash.artifactHash,
            artifacts_hash: hash.artifactHash,
            policy_decision: String(decision.decision ?? "allow"),
            outcome: decision.decision === "block" ? "fail" : "success",
            ts: new Date().toISOString(),
          });
        } catch {
          // best-effort
        }

        return sendJson(res, 200, {
          ok: true,
          allowed,
          requiresApproval,
          preparedId,
          txB64,
          traceId,
          policyReport: decision,
          simulation,
          artifactSchemaVersion: hash.schemaVersion,
          hashAlg: hash.hashAlg,
          artifactHash: hash.artifactHash,
        });
      }

      // Fetch a prepared artifact for verification (hash checking / escrow / attestations).
      if (req.method === "GET" && url.pathname.startsWith("/v1/artifacts/")) {
        const preparedId = decodeURIComponent(url.pathname.split("/").pop() || "");
        if (!preparedId) return sendJson(res, 400, { ok: false, error: "MISSING_PREPARED_ID" });

        const item = prepared.get(preparedId);
        if (!item) return sendJson(res, 404, { ok: false, error: "PREPARED_NOT_FOUND_OR_EXPIRED" });
        if (item.expiresAt <= Date.now()) {
          prepared.delete(preparedId);
          return sendJson(res, 404, { ok: false, error: "PREPARED_NOT_FOUND_OR_EXPIRED" });
        }

        // Never include secrets (extra signers) here.
        const artifact = {
          chain: item.chain,
          adapter: item.adapter,
          action: item.action,
          params: item.params,
          txB64: item.txB64,
          simulation: item.simulation,
          programIds: item.programIds ?? [],
          traceId: item.traceId,
          preparedId: item.preparedId,
          createdAt: item.createdAt,
          expiresAt: item.expiresAt,
        };

        // Recompute hash from canonical artifact object.
        const canonObj = canonicalizeObject(artifact);
        const hash = computeArtifactHash(canonObj);

        return sendJson(res, 200, {
          ok: true,
          artifactSchemaVersion: hash.schemaVersion,
          hashAlg: hash.hashAlg,
          artifactHash: hash.artifactHash,
          artifact: canonObj,
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/actions/execute") {
        const body = await readJsonBody(req);
        const preparedId = String(body.preparedId || "");
        const confirm = body.confirm === true;
        if (!preparedId) return sendJson(res, 400, { ok: false, error: "MISSING_PREPARED_ID" });
        if (!confirm) return sendJson(res, 400, { ok: false, error: "CONFIRM_REQUIRED" });

        // idempotency: if already executed, return stored signature
        const prior = executed.get(preparedId);
        if (prior) {
          return sendJson(res, 200, { ok: true, signature: prior.signature, idempotent: true });
        }

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
              action: normalizePolicyAction(String(item.action)),
              sideEffect: "broadcast",
              simulationOk: item.simulation?.ok === true,
              programIds: item.programIds ?? [],
              programIdsKnown: item.programIdsKnown === true,
            } as any)
          : { decision: "allow" };

        if (decision.decision === "block") {
          trace.emit({ ts: Date.now(), type: "step.finished", runId: traceId, stepId: "execute", data: { ok: false, policy: decision } });

          // Local AgentMemory payload (best-effort)
          try {
            writeMemoryRecord(defaultW3rtDir(), {
              run_id: traceId,
              reasoning_hash: String(item.artifactHash ?? ""),
              artifacts_hash: String(item.artifactHash ?? ""),
              policy_decision: String(decision.decision ?? "block"),
              outcome: "fail",
              ts: new Date().toISOString(),
            });
          } catch {
            // best-effort
          }

          return sendJson(res, 403, { ok: false, error: "POLICY_BLOCK", policyReport: decision, traceId });
        }

        if (decision.decision === "confirm") {
          // caller already confirmed; proceed
        }

        // sign + send
        const raw = Buffer.from(item.txB64, "base64");
        const tx = VersionedTransaction.deserialize(raw);

        // Refresh blockhash right before sending to avoid "Blockhash not found" if it expired.
        await refreshTxBlockhash(conn, tx);

        const extra = Array.isArray(item.extraSigners) ? item.extraSigners : [];
        const extraKps = extra.map((sk) => Keypair.fromSecretKey(sk));
        tx.sign([kp, ...extraKps]);

        const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });

        executed.set(preparedId, { signature: sig, ts: Date.now() });
        persistExecuted();

        trace.emit({ ts: Date.now(), type: "step.finished", runId: traceId, stepId: "execute", data: { ok: true, signature: sig } });

        // Local AgentMemory payload (best-effort)
        try {
          writeMemoryRecord(defaultW3rtDir(), {
            run_id: traceId,
            reasoning_hash: String(item.artifactHash ?? ""),
            artifacts_hash: String(item.artifactHash ?? ""),
            policy_decision: String(decision.decision ?? "allow"),
            outcome: "success",
            ts: new Date().toISOString(),
          });
        } catch {
          // best-effort
        }

        // one-shot use by default
        prepared.delete(preparedId);

        return sendJson(res, 200, { ok: true, signature: sig, traceId });
      }

      // Workflow v0: retry a step by re-compiling it into a new preparedId (refresh blockhash, etc.)
      // POST /v1/workflows/retry_v0
      // Body: { runId, stepId }
      if (req.method === "POST" && url.pathname === "/v1/workflows/retry_v0") {
        const t0 = Date.now();
        let okReq = false;
        try {
          const body = await readJsonBody(req);
        const runId = String(body.runId || "");
        const stepId = String(body.stepId || "");
        if (!runId) return sendJson(res, 400, { ok: false, error: "MISSING_RUN_ID" });
        if (!stepId) return sendJson(res, 400, { ok: false, error: "MISSING_STEP_ID" });

        const plan = loadRunPlan(runId);
        const actions = normalizeActions(plan?.actions ?? plan?.plan?.actions ?? plan?.actions);
        const step = actions.find((a) => String(a.id) === stepId);
        if (!step) return sendJson(res, 404, { ok: false, error: "STEP_NOT_FOUND" });

        const kp = loadSolanaKeypair();
        if (!kp) return sendJson(res, 400, { ok: false, error: "MISSING_SOLANA_KEYPAIR" });

        const rpcUrl = resolveSolanaRpc();
        const network = inferNetworkFromRpcUrl(rpcUrl);
        const drivers = makeDriverRegistry(rpcUrl);
        const driver = drivers[String(step.chain || "solana")];
        if (!driver) return sendJson(res, 400, { ok: false, error: "UNSUPPORTED_CHAIN" });

        const adapter = String(step.adapter || "");
        const action = String(step.action || "");
        const params = (step.params ?? {}) as Dict;

        let built: any;
        try {
          built = await defaultRegistry.get(adapter).buildTx(action, params, {
            userPublicKey: kp.publicKey.toBase58(),
            rpcUrl,
          });
        } catch (e: any) {
          return sendJson(res, 500, { ok: false, error: "BUILD_FAILED", message: String(e?.message ?? e), runId, stepId, adapter, action });
        }

        const txB64 = built.txB64;
        const extraSigners = (built as any).signers as Uint8Array[] | undefined;
        const simulation = await driver.simulateTxB64(txB64, { rpcUrl });
        const { ids: programIds, known } = await driver.extractIdsFromTxB64(txB64, { rpcUrl });

        const decision = policy
          ? policy.decide({
              chain: "solana",
              network,
              action: normalizePolicyAction(String((built as any)?.meta?.action ?? action)),
              sideEffect: "none",
              simulationOk: simulation.ok,
              programIdsKnown: known,
              programIds,
            } as any)
          : { decision: "allow" };

        const requiresApproval = true;
        const allowed = decision.decision === "allow" || decision.decision === "confirm";

        const preparedId = `prep_${crypto.randomUUID().slice(0, 16)}`;
        const now = Date.now();
        const hash = computeArtifactHash({ chain: "solana", adapter, action, params, txB64, simulation, programIds, preparedId, traceId: runId });
        const parsed = safeParseTx(txB64);

        prepared.set(preparedId, {
          preparedId,
          createdAt: now,
          expiresAt: now + ttlMs,
          traceId: runId,
          chain: "solana",
          adapter,
          action,
          params,
          txB64,
          recentBlockhash: parsed?.recentBlockhash,
          extraSigners,
          simulation,
          programIds,
          programIdsKnown: known,
          network,
          artifactSchemaVersion: hash.schemaVersion,
          hashAlg: hash.hashAlg,
          artifactHash: hash.artifactHash,
          artifactCanonicalJson: hash.canonicalJson,
        });

        const meta: any = built.meta ?? {};
        const mints = meta?.mints ?? {};
        const amounts = meta?.amounts ?? {};
        const summary = {
          kind: String(action).includes("swap") ? "swap" : String(action).includes("transfer") ? "transfer" : "unknown",
          chain: "solana",
          stepId,
          adapter: String(meta?.adapter ?? adapter),
          action: String(meta?.action ?? action),
          inputMint: mints.inputMint ?? params.inputMint ?? null,
          outputMint: mints.outputMint ?? params.outputMint ?? null,
          inAmount: amounts.inAmount ?? params.amount ?? null,
          expectedOut: amounts.outAmount ?? null,
          minOut: amounts.minOutAmount ?? null,
          slippageBps: meta.slippageBps ?? params.slippageBps ?? null,
        };

        writeRunStatus(runId, {
          status: "needs_confirm",
          steps: {
            [stepId]: {
              ...(loadRunStatus(runId)?.steps?.[stepId] ?? {}),
              id: stepId,
              adapter: String(meta?.adapter ?? adapter),
              action: String(meta?.action ?? action),
              preparedId,
              allowed,
              requiresApproval,
              simulationOk: simulation.ok === true,
              artifactHash: hash.artifactHash,
              summary,
              state: "prepared",
            },
          },
        });

        okReq = true;
        return sendJson(res, 200, {
          ok: true,
          runId,
          stepId,
          preparedId,
          allowed,
          requiresApproval,
          simulation,
          policyReport: decision,
          summary,
        });
      } finally {
        observeRequest("retry_v0", Date.now() - t0, okReq);
      }
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

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;

  // eslint-disable-next-line no-console
  console.log(`w3rt daemon listening on http://${host}:${actualPort}`);
}
