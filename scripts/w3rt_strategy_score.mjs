#!/usr/bin/env node
/**
 * w3rt_strategy_score.mjs
 * Batch validate/compile/execute (dry-run) strategies.
 *
 * Pipeline per workflow:
 * 1) w3rt-scheduler validate
 * 2) w3rt-scheduler compile -> plan.json
 * 3) w3rt_plan_run --dry-run --summary
 */

import { readdirSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
  const out = {
    dir: null,
    dryRun: true,
    summary: true,
    outDir: null,
    limit: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--out-dir') out.outDir = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--no-dry-run') out.dryRun = false;
    else if (a === '--no-summary') out.summary = false;
  }
  return out;
}

function sh(cmd, opts = {}) {
  const res = spawnSync('bash', ['-lc', cmd], { encoding: 'utf-8', ...opts });
  return res;
}

function nowId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) throw new Error('Usage: node scripts/w3rt_strategy_score.mjs --dir <strategiesDir>');

  const baseDir = resolve(args.dir);
  const files = readdirSync(baseDir).filter(f => f.endsWith('.json')).sort();
  const chosen = args.limit > 0 ? files.slice(0, args.limit) : files;

  const outDir = resolve(args.outDir || `/tmp/w3rt-strategy-score-${nowId()}`);
  mkdirSync(outDir, { recursive: true });

  const results = [];

  for (const f of chosen) {
    const workflowPath = join(baseDir, f);
    const name = f;
    const planPath = join(outDir, f.replace(/\.json$/, '.plan.json'));

    const env = `export PATH="$HOME/.local/bin:$PATH"; eval "$(opam env --switch=w3rt-ocaml --set-switch)";`;

    const t0 = Date.now();

    // 1) validate
    let r = sh(`${env} cd /home/davirain/clawd/web3AIRuntime/ocaml-scheduler && opam exec -- dune exec -- w3rt-scheduler validate ${JSON.stringify(workflowPath)}`);
    if (r.status !== 0) {
      results.push({ name, ok: false, stage: 'validate', code: r.status, stderr: (r.stderr || r.stdout || '').trim().slice(0, 2000) });
      continue;
    }

    // 2) compile
    r = sh(`${env} cd /home/davirain/clawd/web3AIRuntime/ocaml-scheduler && opam exec -- dune exec -- w3rt-scheduler compile ${JSON.stringify(workflowPath)} --out ${JSON.stringify(planPath)}`);
    if (r.status !== 0) {
      results.push({ name, ok: false, stage: 'compile', code: r.status, stderr: (r.stderr || r.stdout || '').trim().slice(0, 2000) });
      continue;
    }

    // 3) run plan
    const runArgs = [`cd /home/davirain/clawd/web3AIRuntime && node scripts/w3rt_plan_run.mjs --plan ${JSON.stringify(planPath)}`];
    if (args.dryRun) runArgs.push('--dry-run');
    if (args.summary) runArgs.push('--summary');

    r = sh(runArgs.join(' '));

    const dt = Date.now() - t0;
    if (r.status !== 0) {
      results.push({ name, ok: false, stage: 'run', code: r.status, ms: dt, stderr: (r.stderr || r.stdout || '').trim().slice(0, 2000) });
      continue;
    }

    // parse summary lines to extract route/quoteId quickly
    const outText = (r.stdout || '').trim();
    const route = (outText.match(/route=([^\s]+)/) || [])[1] || null;
    const quoteId = (outText.match(/quoteId\s+([^\s]+)/) || [])[1] || null;

    results.push({ name, ok: true, stage: 'done', ms: dt, route, quoteId, planPath, output: outText.split('\n').slice(0, 50).join('\n') });
  }

  // Score: prefer ok + route=jupiter, then meteora; faster is better.
  function scoreRow(x) {
    if (!x.ok) return -1;
    const routeScore = x.route === 'jupiter' ? 2 : x.route === 'meteora' ? 1 : 0;
    const speedScore = x.ms ? Math.max(0, 20000 - x.ms) / 20000 : 0;
    return routeScore + speedScore;
  }

  const ranked = [...results].sort((a, b) => scoreRow(b) - scoreRow(a));

  const report = { ok: true, baseDir, outDir, count: results.length, ranked };
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  // Print top 10
  const top = ranked.slice(0, 10).map(r => ({ name: r.name, ok: r.ok, route: r.route, ms: r.ms, quoteId: r.quoteId }));
  console.log(JSON.stringify({ ok: true, outDir, top }, null, 2));
}

try { main(); } catch (e) {
  console.error(e?.stack || String(e));
  process.exit(1);
}
