#!/usr/bin/env node
/**
 * w3rt_swap_safe.mjs
 * Two-step safe swap helper for OpenClaw skills.
 *
 * Commands:
 *   quote  --from SOL --to USDC --amount 0.01 --slippage-bps 50 [--allow-fallback]
 *   exec   --quote-id <id> --confirm I_CONFIRM
 *   show  --run-id <runId> | --path <swap.json>
 *
 * Notes:
 * - Stores quotes in ~/.w3rt/tmp/swap-quotes.json (best-effort)
 * - Always simulates before sending (fail-closed)
 */

import os from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import yaml from 'js-yaml';
import { Keypair } from '@solana/web3.js';
import { createSolanaTools } from '@w3rt/runtime';

function w3rtDir() {
  return process.env.W3RT_DIR || join(os.homedir(), '.w3rt');
}

function loadConfig() {
  const p = join(w3rtDir(), 'config.yaml');
  if (!existsSync(p)) return {};
  return yaml.load(readFileSync(p, 'utf-8')) || {};
}

function loadKeypair() {
  const cfg = loadConfig();
  const kpPath = cfg?.wallet?.keyPath;
  if (!kpPath) return null;
  const full = String(kpPath).startsWith('/') ? String(kpPath) : join(w3rtDir(), String(kpPath));
  if (!existsSync(full)) return null;
  const secret = JSON.parse(readFileSync(full, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

const TOKEN_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  WSOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
};
function resolveMint(x) {
  const u = String(x).trim().toUpperCase();
  return TOKEN_MINTS[u] || String(x).trim();
}

function tmpDir() {
  const d = join(w3rtDir(), 'tmp');
  mkdirSync(d, { recursive: true });
  return d;
}

function runsDir() {
  const d = join(w3rtDir(), 'runs');
  mkdirSync(d, { recursive: true });
  return d;
}

const QUOTE_STORE = join(tmpDir(), 'swap-quotes.json');

function readQuoteStore() {
  try {
    if (!existsSync(QUOTE_STORE)) return {};
    return JSON.parse(readFileSync(QUOTE_STORE, 'utf-8')) || {};
  } catch {
    return {};
  }
}
function writeQuoteStore(obj) {
  writeFileSync(QUOTE_STORE, JSON.stringify(obj, null, 2));
}

function policy(cfg) {
  const p = cfg?.policy || {};
  return {
    maxSlippageBps: typeof p.maxSlippageBps === 'number' ? p.maxSlippageBps : 100,
    maxSwapInputSol: typeof p.maxSwapInputSol === 'number' ? p.maxSwapInputSol : 0.25,
    maxSwapInputUsdc: typeof p.maxSwapInputUsdc === 'number' ? p.maxSwapInputUsdc : 250,
    requireConfirmPhrase: p.requireConfirmPhrase || 'I_CONFIRM',
  };
}

function parse(argv) {
  const cmd = argv[0];
  const args = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') args.from = argv[++i];
    else if (a === '--to') args.to = argv[++i];
    else if (a === '--amount') args.amount = argv[++i];
    else if (a === '--slippage-bps') args.slippageBps = Number(argv[++i]);
    else if (a === '--allow-fallback') args.allowFallback = true;
    else if (a === '--quote-id') args.quoteId = argv[++i];
    else if (a === '--confirm') args.confirm = argv[++i];
    else if (a === '--run-id') args.runId = argv[++i];
    else if (a === '--path') args.path = argv[++i];
    else if (a === '--plan-hash') args.planHash = argv[++i];
  }
  return { cmd, args };
}

async function main() {
  const { cmd, args } = parse(process.argv.slice(2));
  const cfg = loadConfig();
  const kp = loadKeypair();
  if (!kp) throw new Error('Wallet not configured: set wallet.keyPath in ~/.w3rt/config.yaml');

  const pol = policy(cfg);

  const tools = createSolanaTools({
    getRpcUrl: () => cfg?.solana?.rpc || 'https://api.mainnet-beta.solana.com',
    getKeypair: () => kp,
    getJupiterBaseUrl: () => cfg?.jupiter?.baseUrl || 'https://quote-api.jup.ag/v6',
    getJupiterApiKey: () => cfg?.jupiter?.apiKey,
  });

  const router = tools.find(t => t.name === 'solana_swap_exact_in');
  const simTool = tools.find(t => t.name === 'solana_simulate_tx');
  const sendTool = tools.find(t => t.name === 'solana_send_tx');
  const confTool = tools.find(t => t.name === 'solana_confirm_tx');

  if (!router || !simTool || !sendTool || !confTool) {
    throw new Error('Missing required runtime tools for swap');
  }

  if (cmd === 'quote') {
    const from = args.from;
    const to = args.to;
    const amount = Number(args.amount);
    if (!from || !to || !Number.isFinite(amount) || amount <= 0) throw new Error('Usage: quote --from SOL --to USDC --amount 0.01');

    const slip = Number.isFinite(args.slippageBps) ? Number(args.slippageBps) : pol.maxSlippageBps;
    if (slip > pol.maxSlippageBps) throw new Error(`slippageBps ${slip} exceeds policy maxSlippageBps ${pol.maxSlippageBps}`);

    const inputMint = resolveMint(from);
    const outputMint = resolveMint(to);

    if (String(from).toUpperCase() === 'SOL' && amount > pol.maxSwapInputSol) throw new Error(`Amount ${amount} SOL exceeds policy maxSwapInputSol ${pol.maxSwapInputSol}`);
    if ((String(from).toUpperCase() === 'USDC' || String(from).toUpperCase() === 'USDT') && amount > pol.maxSwapInputUsdc) throw new Error(`Amount ${amount} exceeds policy maxSwapInputUsdc ${pol.maxSwapInputUsdc}`);

    const decimals = inputMint === TOKEN_MINTS.SOL ? 9 : 6;
    const amountLamports = Math.floor(amount * 10 ** decimals).toString();

    const ctx = {
      __profile: {
        allowedProtocols: ['jupiter', 'meteora'],
        requireConfirmOnFallback: args.allowFallback === true,
      },
    };

    const built = await router.execute({ inputMint, outputMint, amount: amountLamports, slippageBps: slip }, ctx);
    if (!built?.ok) throw new Error(built?.error || 'swap build failed');

    const quoteId = String(ctx.quote?.quoteId || ('q_' + crypto.randomBytes(4).toString('hex')));

    const store = readQuoteStore();
    store[quoteId] = {
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 2 * 60 * 1000,
      route: built.route,
      txB64: built.txB64,
      ctx,
    };
    writeQuoteStore(store);

    console.log(JSON.stringify({
      ok: true,
      quoteId,
      route: built.route,
      amountLamports,
      inputMint,
      outputMint,
      slippageBps: slip,
      expiresInSec: 120,
      next: { cmd: 'exec', quoteId, confirm: pol.requireConfirmPhrase }
    }, null, 2));
    return;
  }

  if (cmd === 'show') {
    const runId = args.runId;
    const pathArg = args.path;

    let p;
    if (pathArg) {
      p = String(pathArg);
    } else if (runId) {
      p = join(runsDir(), String(runId), 'swap.json');
    } else {
      throw new Error('Usage: show --run-id <runId>  (or: show --path <swap.json>)');
    }

    if (!existsSync(p)) throw new Error(`Artifact not found: ${p}`);
    const a = JSON.parse(readFileSync(p, 'utf-8'));

    const lines = [];
    lines.push('## w3rt swap artifact');
    lines.push(`runId: ${a.runId}`);
    lines.push(`createdAt: ${a.createdAt}`);
    lines.push(`route: ${a.route}`);
    lines.push(`quoteId: ${a.quoteId}`);
    if (a?.input?.amountLamports) lines.push(`amountLamports: ${a.input.amountLamports}`);
    if (a?.input?.requestedSlippageBps != null) lines.push(`slippageBps: ${a.input.requestedSlippageBps}`);
    lines.push(`signature: ${a?.tx?.signature}`);
    lines.push(`solscan: ${a?.tx?.explorerUrl}`);
    if (a?.simulation?.unitsConsumed != null) lines.push(`unitsConsumed: ${a.simulation.unitsConsumed}`);
    if (a?.simulation?.simulatedOutAmount != null) lines.push(`simulatedOutAmount: ${a.simulation.simulatedOutAmount}`);

    console.log(lines.join('\n'));
    return;
  }

  if (cmd === 'exec') {
    const quoteId = args.quoteId;
    const confirm = args.confirm;
    const planHash = args.planHash;
    if (!quoteId || !confirm) throw new Error('Usage: exec --quote-id <id> --confirm I_CONFIRM');
    if (String(confirm) !== String(pol.requireConfirmPhrase)) throw new Error(`Invalid confirm phrase. Must equal: ${pol.requireConfirmPhrase}`);

    const store = readQuoteStore();
    const q = store[quoteId];
    if (!q) throw new Error(`Unknown quoteId: ${quoteId}`);
    if (Date.now() > q.expiresAtMs) throw new Error(`quoteId expired: ${quoteId}`);

    const sim = await simTool.execute({ txB64: q.txB64 }, q.ctx);
    if (!sim?.ok) {
      console.log(JSON.stringify({ ok: false, stage: 'simulate', err: sim?.err ?? null, logs: (sim?.logs || []).slice(0, 30) }, null, 2));
      process.exit(2);
    }

    const sent = await sendTool.execute({ txB64: q.txB64 }, q.ctx);
    if (!sent?.ok) throw new Error(sent?.error || 'send failed');

    const conf = await confTool.execute({ signature: sent.signature }, q.ctx);
    const out = {
      ok: !!conf?.ok,
      signature: sent.signature,
      explorerUrl: `https://solscan.io/tx/${sent.signature}`,
      confirm: conf,
      simulation: { unitsConsumed: sim.unitsConsumed ?? null, simulatedOutAmount: sim.simulatedOutAmount ?? null }
    };

    // Write run artifact for audit/replay
    const runId = `swap_${Date.now()}_${String(sent.signature).slice(0, 8)}`;
    const runPath = join(runsDir(), runId);
    mkdirSync(runPath, { recursive: true });
    const artifact = {
      schema: 'w3rt.swap.v1',
      runId,
      createdAt: new Date().toISOString(),
      quoteId,
      route: q.route,
      input: {
        inputMint: q?.ctx?.quote?.quoteResponse?.inputMint ?? null,
        outputMint: q?.ctx?.quote?.quoteResponse?.outputMint ?? null,
        amountLamports: q?.ctx?.quote?.quoteResponse?.inAmount ?? null,
        requestedSlippageBps: q?.ctx?.quote?.requestedSlippageBps ?? null,
      },
      tx: {
        signature: sent.signature,
        explorerUrl: `https://solscan.io/tx/${sent.signature}`,
      },
      simulation: {
        ok: true,
        unitsConsumed: sim.unitsConsumed ?? null,
        simulatedOutAmount: sim.simulatedOutAmount ?? null,
      },
      confirm: conf,
      policy: pol,
      planHash: planHash || null,
    };
    writeFileSync(join(runPath, 'swap.json'), JSON.stringify(artifact, null, 2));

    delete store[quoteId];
    writeQuoteStore(store);

    console.log(JSON.stringify({ ...out, runId, artifactPath: join(runPath, 'swap.json') }, null, 2));
    return;
  }

  console.log('Usage:\n  node scripts/w3rt_swap_safe.mjs quote --from SOL --to USDC --amount 0.01 --slippage-bps 50 [--allow-fallback]\n  node scripts/w3rt_swap_safe.mjs exec --quote-id <id> --confirm I_CONFIRM\n  node scripts/w3rt_swap_safe.mjs show --run-id <runId>');
  process.exit(1);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
