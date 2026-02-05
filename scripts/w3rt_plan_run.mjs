#!/usr/bin/env node
/**
 * w3rt_plan_run.mjs
 * Execute a compiled plan (w3rt.plan.v1) produced by ocaml-scheduler.
 *
 * Usage:
 *   node scripts/w3rt_plan_run.mjs --plan /path/to/plan.json
 *
 * Supports tools:
 * - w3rt_balance
 * - w3rt_swap_quote
 * - w3rt_swap_exec
 *
 * Notes:
 * - This runner is intentionally conservative: it executes steps in order and enforces dependsOn are completed.
 * - Swap exec requires explicit confirm in plan params (e.g. I_CONFIRM).
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
  const out = { plan: null, dryRun: false, summary: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan') out.plan = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--summary') out.summary = true;
  }
  return out;
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || '').trim();
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}\n${err}`);
  }
  return (res.stdout || '').trim();
}

function jsonOrText(s) {
  try { return JSON.parse(s); } catch { return s; }
}

async function main() {
  const { plan, dryRun, summary } = parseArgs(process.argv.slice(2));
  if (!plan) {
    console.log('Usage: node scripts/w3rt_plan_run.mjs --plan /path/to/plan.json [--dry-run] [--summary]');
    process.exit(1);
  }

  const raw = readFileSync(plan, 'utf-8');
  const p = JSON.parse(raw);
  if (p.schema !== 'w3rt.plan.v1') throw new Error(`Unsupported plan schema: ${p.schema}`);

  const steps = Array.isArray(p.steps) ? p.steps : [];
  const done = new Set();
  const outputs = {};

  // Execute steps in a deterministic topological order (do not trust JSON order).
  const remaining = new Map(steps.map(s => [s.id, s]));

  while (remaining.size > 0) {
    const ready = [];
    for (const step of remaining.values()) {
      const deps = Array.isArray(step.dependsOn) ? step.dependsOn : [];
      if (deps.every(d => done.has(d))) ready.push(step);
    }
    if (ready.length === 0) {
      const blocked = [...remaining.values()].map(s => ({ id: s.id, dependsOn: s.dependsOn }));
      throw new Error(`No runnable steps found (cycle or missing deps). Remaining: ${JSON.stringify(blocked, null, 2)}`);
    }

    // Deterministic choice among runnable steps
    ready.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const step = ready[0];

    const id = step.id;
    const tool = step.tool;
    const params = step.params || {};

    console.log(`\n==> Step ${id}: ${tool}`);

    if (tool === 'w3rt_balance') {
      const args = ['scripts/w3rt_balance.mjs'];
      if (params.address) args.push('--address', String(params.address));
      if (params.includeTokens === true) args.push('--include-tokens');
      if (params.tokenMint) args.push('--token-mint', String(params.tokenMint));
      const out = run('node', args);
      outputs[id] = jsonOrText(out);
    } else if (tool === 'w3rt_swap_quote') {
      const args = ['scripts/w3rt_swap_safe.mjs', 'quote', '--from', String(params.from || params.fromToken || 'SOL'), '--to', String(params.to || params.toToken || 'USDC'), '--amount', String(params.amount || '0.01')];
      if (params.slippageBps != null) args.push('--slippage-bps', String(params.slippageBps));
      if (params.allowFallback === true) args.push('--allow-fallback');
      const out = run('node', args);
      const j = JSON.parse(out);
      outputs[id] = j;
      outputs.__lastQuoteId = j.quoteId;
    } else if (tool === 'w3rt_swap_exec') {
      const quoteId = params.quoteId || outputs.__lastQuoteId;
      if (!quoteId) throw new Error('swap_exec missing quoteId (and no previous swap_quote output found)');
      const confirm = params.confirm;
      if (!confirm) throw new Error('swap_exec missing confirm');

      const planHash = p?.meta?.planHash;

      if (dryRun) {
        outputs[id] = {
          ok: true,
          dryRun: true,
          wouldExec: true,
          quoteId,
          planHash: planHash || null,
          note: 'dry-run mode: swap execution skipped',
        };
      } else {
        const args = ['scripts/w3rt_swap_safe.mjs', 'exec', '--quote-id', String(quoteId), '--confirm', String(confirm)];
        if (planHash) args.push('--plan-hash', String(planHash));
        const out = run('node', args);
        outputs[id] = JSON.parse(out);
      }
    } else {
      throw new Error(`Unsupported tool: ${tool}`);
    }

    done.add(id);
    remaining.delete(id);
  }

  const result = { ok: true, workflow: p.workflow, dryRun, outputs };

  if (summary) {
    const lines = [];
    lines.push(`## Plan completed${dryRun ? ' (dry-run)' : ''}`);
    lines.push(`workflow: ${p.workflow}`);

    for (const step of steps) {
      const o = outputs[step.id];
      if (!o) continue;
      if (step.tool === 'w3rt_balance' && o.ok && o.sol) {
        lines.push(`- ${step.id}: balance ${Number(o.sol.sol).toFixed(4)} SOL`);
      } else if (step.tool === 'w3rt_swap_quote' && o.ok) {
        lines.push(`- ${step.id}: quoteId ${o.quoteId} route=${o.route}`);
      } else if (step.tool === 'w3rt_swap_exec' && o.ok) {
        if (o.dryRun) lines.push(`- ${step.id}: (skipped) would exec quoteId=${o.quoteId}`);
        else lines.push(`- ${step.id}: signature ${o.signature} runId=${o.runId}`);
      } else {
        lines.push(`- ${step.id}: done`);
      }
    }

    console.log(lines.join('\n'));
  } else {
    console.log('\n=== Plan completed ===');
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
