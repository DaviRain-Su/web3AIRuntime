#!/usr/bin/env node
/**
 * w3rt_strategy_gen.mjs
 * Generate many small workflow.json strategies (A-mode: fun + safe; intended for dry-run scoring).
 *
 * Defaults:
 * - pair: SOL -> USDC
 * - amount range: 0.005..0.02 SOL
 * - slippage: 50 bps
 * - count: 20
 * - allowFallback: true
 *
 * Output: a directory containing strategy_001.json ...
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function parseArgs(argv) {
  const out = {
    count: 20,
    from: 'SOL',
    to: 'USDC',
    min: 0.005,
    max: 0.02,
    slippageBps: 50,
    allowFallback: true,
    outDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--count') out.count = Number(argv[++i]);
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--min') out.min = Number(argv[++i]);
    else if (a === '--max') out.max = Number(argv[++i]);
    else if (a === '--slippage-bps') out.slippageBps = Number(argv[++i]);
    else if (a === '--allow-fallback') out.allowFallback = true;
    else if (a === '--no-allow-fallback') out.allowFallback = false;
    else if (a === '--out-dir') out.outDir = argv[++i];
  }
  return out;
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function randBetween(min, max) {
  return min + Math.random() * (max - min);
}

function roundTo(x, decimals) {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}

function mkWorkflow({ name, from, to, amount, slippageBps, allowFallback, variant }) {
  // Keep it minimal. Compiler will inject balance_before/after and patch deps.
  return {
    name,
    actions: [
      {
        id: 'swap_quote',
        tool: 'w3rt_swap_quote',
        params: {
          from,
          to,
          amount: String(amount),
          slippageBps,
          allowFallback,
          variant,
        },
        dependsOn: [],
      },
      {
        id: 'swap_exec',
        tool: 'w3rt_swap_exec',
        params: {
          // A-mode intended for dry-run; still include confirm so it compiles.
          confirm: 'I_CONFIRM',
        },
        dependsOn: ['swap_quote'],
      },
    ],
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(args.count) || args.count <= 0) throw new Error('invalid --count');
  if (!Number.isFinite(args.min) || !Number.isFinite(args.max) || args.min <= 0 || args.max < args.min) throw new Error('invalid --min/--max');

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = resolve(args.outDir || `/tmp/w3rt-strategies-${ts}`);
  mkdirSync(outDir, { recursive: true });

  const variants = [
    { id: 'baseline', tweak: (x) => x },
    { id: 'low-slip', tweak: (x) => x },
    { id: 'high-slip', tweak: (x) => x },
    { id: 'no-fallback', tweak: (x) => x },
    { id: 'fallback', tweak: (x) => x },
  ];

  for (let i = 1; i <= args.count; i++) {
    const v = variants[(i - 1) % variants.length];

    let slippageBps = args.slippageBps;
    let allowFallback = args.allowFallback;

    if (v.id === 'low-slip') slippageBps = Math.max(10, Math.floor(args.slippageBps / 2));
    if (v.id === 'high-slip') slippageBps = Math.min(100, Math.floor(args.slippageBps * 2));
    if (v.id === 'no-fallback') allowFallback = false;
    if (v.id === 'fallback') allowFallback = true;

    const amount = roundTo(randBetween(args.min, args.max), 4);
    const name = `strategy-${pad3(i)}-${args.from}-${args.to}-${v.id}`;

    const wf = mkWorkflow({
      name,
      from: args.from,
      to: args.to,
      amount,
      slippageBps,
      allowFallback,
      variant: v.id,
    });

    const p = join(outDir, `strategy_${pad3(i)}.json`);
    writeFileSync(p, JSON.stringify(wf, null, 2));
  }

  console.log(JSON.stringify({
    ok: true,
    outDir,
    count: args.count,
    defaults: {
      from: args.from,
      to: args.to,
      min: args.min,
      max: args.max,
      slippageBps: args.slippageBps,
      allowFallback: args.allowFallback,
    },
    next: {
      hint: 'Score them with: node scripts/w3rt_strategy_score.mjs --dir <outDir> --dry-run --summary'
    }
  }, null, 2));
}

try { main(); } catch (e) {
  console.error(e?.stack || String(e));
  process.exit(1);
}
