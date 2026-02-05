#!/usr/bin/env node
/**
 * w3rt_verify_run.mjs
 * One-command verification for a workflow run folder produced by w3rt_plan_run.mjs.
 *
 * Verifies:
 * - run.json exists and is consistent with plan.json (planHash + policyHash)
 * - all step artifacts referenced by run.json exist
 * - if swap_exec produced a swapRunId/artifactPath, verify swap.json against plan.json via w3rt-scheduler verify
 *
 * Usage:
 *   node scripts/w3rt_verify_run.mjs --run-id <plan_run_id>
 *   node scripts/w3rt_verify_run.mjs --path ~/.w3rt/runs/<plan_run_id>
 */

import os from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function w3rtDir() {
  return process.env.W3RT_DIR || join(os.homedir(), '.w3rt');
}

function parseArgs(argv) {
  const out = { runId: null, path: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-id') out.runId = argv[++i];
    else if (a === '--path') out.path = argv[++i];
  }
  return out;
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function fail(msg, extra) {
  const e = { ok: false, error: msg, ...(extra || {}) };
  console.error(JSON.stringify(e, null, 2));
  process.exit(2);
}

function sh(cmd) {
  const res = spawnSync('bash', ['-lc', cmd], { encoding: 'utf-8' });
  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || '').trim();
    throw new Error(`Command failed: ${cmd}\n${err}`);
  }
  return (res.stdout || '').trim();
}

function main() {
  const { runId, path } = parseArgs(process.argv.slice(2));
  const runPath = resolve(path || join(w3rtDir(), 'runs', String(runId || '')));
  if (!existsSync(runPath)) fail('runPath not found', { runPath });

  const runJsonPath = join(runPath, 'run.json');
  const planJsonPath = join(runPath, 'plan.json');

  if (!existsSync(runJsonPath)) fail('missing run.json', { runJsonPath });
  if (!existsSync(planJsonPath)) fail('missing plan.json', { planJsonPath });

  const runObj = readJson(runJsonPath);
  const planObj = readJson(planJsonPath);

  const planHash = planObj?.meta?.planHash || null;
  const policyHash = planObj?.meta?.policyHash || null;

  if (!planHash) fail('plan.meta.planHash missing', { planJsonPath });

  // Check run.json consistency
  if (runObj?.planHash && runObj.planHash !== planHash) {
    fail('run.planHash mismatch', { expected: planHash, got: runObj.planHash });
  }
  if (policyHash) {
    if (!runObj?.policyHash) fail('run.policyHash missing but plan has policyHash', { policyHash });
    if (runObj.policyHash !== policyHash) fail('run.policyHash mismatch', { expected: policyHash, got: runObj.policyHash });
  }

  // Step artifact existence
  const steps = Array.isArray(runObj?.steps) ? runObj.steps : [];
  const missing = [];
  for (const s of steps) {
    const rel = s?.artifact;
    if (!rel) continue;
    const p = join(runPath, rel);
    if (!existsSync(p)) missing.push({ stepId: s?.id, artifact: p });
  }
  if (missing.length) fail('missing step artifacts', { missing });

  // If there is a swap_exec step, try to verify swap artifact too (if present)
  const swapStep = steps.find(s => s?.tool === 'w3rt_swap_exec');
  let swapVerify = null;

  if (swapStep?.artifact) {
    const stepArtifactPath = join(runPath, swapStep.artifact);
    const stepArtifact = readJson(stepArtifactPath);
    const swapRunId = stepArtifact?.output?.runId || stepArtifact?.output?.swapRunId || null;
    const swapArtifactPath = stepArtifact?.output?.artifactPath || null;

    // swapArtifactPath is absolute; if not, try resolve from swapRunId
    let swapJsonPath = null;
    if (swapArtifactPath && existsSync(swapArtifactPath)) swapJsonPath = swapArtifactPath;
    else if (swapRunId) {
      const p = join(w3rtDir(), 'runs', swapRunId, 'swap.json');
      if (existsSync(p)) swapJsonPath = p;
    }

    if (swapJsonPath) {
      // Use OCaml verifier for canonical consistency.
      const env = `export PATH="$HOME/.local/bin:$PATH"; eval "$(opam env --switch=w3rt-ocaml --set-switch)";`;
      const cmd = `${env} cd /home/davirain/clawd/web3AIRuntime/ocaml-scheduler && opam exec -- dune exec -- w3rt-scheduler verify ${JSON.stringify(planJsonPath)} ${JSON.stringify(swapJsonPath)}`;
      const out = sh(cmd);
      swapVerify = { ok: true, swapJsonPath, verifierOutput: out };
    } else {
      // dry-run or artifact missing
      swapVerify = { ok: false, note: 'swap artifact not found (dry-run or missing)', stepArtifactPath };
    }
  }

  const result = {
    ok: true,
    runPath,
    runId: runObj.runId,
    planHash,
    policyHash: policyHash || null,
    checks: {
      runJson: true,
      planJson: true,
      stepArtifacts: true,
      swapVerify,
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

try {
  main();
} catch (e) {
  fail('exception', { message: String(e?.message || e) });
}
