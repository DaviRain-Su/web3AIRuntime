#!/usr/bin/env node
/**
 * w3rt_tg_cli.mjs
 * Telegram-style command handler (strict command mode) for the w3rt harness.
 *
 * This script is designed to be called by an agent that receives chat messages.
 * It maintains a tiny pending state in ~/.w3rt/tmp/pending_swap.json.
 *
 * Commands:
 *   help
 *   swap SOL USDC 0.01
 *   I_CONFIRM
 *   receipt <planRunId>
 */

import os from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

function w3rtDir() {
  return process.env.W3RT_DIR || join(os.homedir(), '.w3rt');
}
function tmpDir() {
  const d = join(w3rtDir(), 'tmp');
  mkdirSync(d, { recursive: true });
  return d;
}
const PENDING_PATH = join(tmpDir(), 'pending_swap.json');

function loadConfig() {
  const p = join(w3rtDir(), 'config.yaml');
  if (!existsSync(p)) return {};
  return yaml.load(readFileSync(p, 'utf-8')) || {};
}

function sh(cmd) {
  const res = spawnSync('bash', ['-lc', cmd], { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || '').trim();
    throw new Error(err || `Command failed: ${cmd}`);
  }
  return (res.stdout || '').trim();
}

function ocamlPrefix() {
  return 'export PATH="$HOME/.local/bin:$PATH"; eval "$(opam env --switch=w3rt-ocaml --set-switch)";';
}

function nowMs() {
  return Date.now();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}
function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

function helpText() {
  return [
    'w3rt (Solana safe swap) commands:',
    '',
    '1) Preview (dry-run):',
    '   swap SOL USDC 0.01',
    '',
    '2) Execute (requires confirm):',
    '   I_CONFIRM',
    '',
    '3) Receipt / audit:',
    '   receipt <planRunId>',
    '',
    'Safety:',
    '- Policy limits enforced (slippage/amount caps).',
    '- Always simulate before sending.',
    '- All runs produce artifacts + can be verified (planHash/policyHash).',
  ].join('\n');
}

function parseSwap(line) {
  const parts = line.trim().split(/\s+/);
  // swap FROM TO AMOUNT
  if (parts.length !== 4) return null;
  const [, from, to, amountStr] = parts;
  const amount = Number(amountStr);
  if (!from || !to || !Number.isFinite(amount) || amount <= 0) return null;
  return { from, to, amountStr };
}

function makeWorkflow({ from, to, amountStr }) {
  return {
    name: `tg-swap-${from}-${to}-${amountStr}`,
    actions: [
      {
        id: 'swap_quote',
        tool: 'w3rt_swap_quote',
        params: {
          from,
          to,
          amount: amountStr,
          // slippage/allowFallback default to policy/tool defaults; user-facing simplicity
          allowFallback: true,
        },
        dependsOn: [],
      },
      {
        id: 'swap_exec',
        tool: 'w3rt_swap_exec',
        params: {
          confirm: 'I_CONFIRM',
        },
        dependsOn: ['swap_quote'],
      },
    ],
  };
}

function compileWithPolicy(workflowObj) {
  const tmp = tmpDir();
  const wfPath = join(tmp, `tg_wf_${nowMs()}.json`);
  const planPath = join(tmp, `tg_plan_${nowMs()}.json`);
  writeJson(wfPath, workflowObj);

  const cfg = loadConfig();
  const policy = cfg.policy || null;
  let policyArg = '';
  if (policy) {
    const policyPath = join(tmp, `tg_policy_${nowMs()}.json`);
    writeJson(policyPath, policy);
    policyArg = ` --policy ${JSON.stringify(policyPath)}`;
  }

  const prefix = ocamlPrefix();
  sh(`${prefix} cd /home/davirain/clawd/web3AIRuntime/ocaml-scheduler && opam exec -- dune exec -- w3rt-scheduler compile ${JSON.stringify(wfPath)}${policyArg} --out ${JSON.stringify(planPath)}`);
  const plan = readJson(planPath);
  return { plan, planPath };
}

function runPlanSummary(planPath, { dryRun }) {
  const cmd = [
    `cd /home/davirain/clawd/web3AIRuntime`,
    `node scripts/w3rt_plan_run.mjs --plan ${JSON.stringify(planPath)} --summary ${dryRun ? '--dry-run' : ''}`.trim(),
  ].join(' && ');
  const out = sh(cmd);
  const runId = (out.match(/\brunId:\s*(\S+)/) || [])[1] || null;
  const quoteId = (out.match(/quoteId\s+(\S+)/) || [])[1] || null;
  const route = (out.match(/route=([^\s]+)/) || [])[1] || null;
  const signature = (out.match(/signature\s+(\S+)/) || [])[1] || null;
  const swapRunId = (out.match(/swapRunId=(\S+)/) || [])[1] || null;
  const planHash = (out.match(/\bplanHash:\s*(\S+)/) || [])[1] || null;
  return { out, runId, quoteId, route, signature, swapRunId, planHash };
}

function savePending(obj) {
  writeJson(PENDING_PATH, obj);
}
function loadPending() {
  if (!existsSync(PENDING_PATH)) return null;
  try {
    return readJson(PENDING_PATH);
  } catch {
    return null;
  }
}
function clearPending() {
  try {
    if (existsSync(PENDING_PATH)) writeJson(PENDING_PATH, { clearedAtMs: nowMs() });
  } catch {}
}

function receiptFromRunId(planRunId) {
  const runPath = join(w3rtDir(), 'runs', planRunId);
  const runJson = join(runPath, 'run.json');
  const planJson = join(runPath, 'plan.json');
  if (!existsSync(runJson) || !existsSync(planJson)) {
    return `Receipt not found for runId: ${planRunId}`;
  }

  const run = readJson(runJson);
  const plan = readJson(planJson);

  let swapInfo = null;
  const swapStep = (run.steps || []).find(s => s.tool === 'w3rt_swap_exec');
  if (swapStep?.artifact) {
    const stepArtifact = readJson(join(runPath, swapStep.artifact));
    const out = stepArtifact?.output || {};
    swapInfo = {
      signature: out.signature || null,
      swapRunId: out.runId || out.swapRunId || null,
      artifactPath: out.artifactPath || null,
    };
  }

  // Verify (best-effort)
  let verifyLine = 'verify: (not run)';
  try {
    const cmd = `cd /home/davirain/clawd/web3AIRuntime && node scripts/w3rt_verify_run.mjs --run-id ${JSON.stringify(planRunId)} | jq -r '.ok'`;
    const ok = sh(cmd).trim();
    verifyLine = `verify: ${ok === 'true' ? 'OK ✅' : 'FAIL ❌'}`;
  } catch {
    verifyLine = 'verify: error';
  }

  const lines = [];
  lines.push('--- w3rt receipt ---');
  lines.push(`planRunId: ${planRunId}`);
  if (plan?.meta?.planHash) lines.push(`planHash: ${plan.meta.planHash}`);
  if (plan?.meta?.policyHash) lines.push(`policyHash: ${plan.meta.policyHash}`);
  lines.push(verifyLine);

  if (swapInfo?.signature) {
    lines.push(`signature: ${swapInfo.signature}`);
    lines.push(`solscan: https://solscan.io/tx/${swapInfo.signature}`);
  }
  if (swapInfo?.swapRunId) lines.push(`swapRunId: ${swapInfo.swapRunId}`);

  return lines.join('\n');
}

function main() {
  const line = process.argv.slice(2).join(' ').trim();
  if (!line) {
    console.log(helpText());
    return;
  }

  if (line === 'help') {
    console.log(helpText());
    return;
  }

  if (line.startsWith('swap ')) {
    const parsed = parseSwap(line);
    if (!parsed) {
      console.log('Usage: swap SOL USDC 0.01');
      return;
    }

    const wf = makeWorkflow(parsed);
    const { plan, planPath } = compileWithPolicy(wf);
    const preview = runPlanSummary(planPath, { dryRun: true });

    const expiresAtMs = nowMs() + 2 * 60 * 1000;
    savePending({
      kind: 'swap',
      createdAtMs: nowMs(),
      expiresAtMs,
      workflow: wf,
      planPath,
      planHash: plan?.meta?.planHash || null,
      policyHash: plan?.meta?.policyHash || null,
      previewRunId: preview.runId,
      from: parsed.from,
      to: parsed.to,
      amount: parsed.amountStr,
      quoteId: preview.quoteId,
      route: preview.route,
    });

    const lines = [];
    lines.push('== Swap preview (dry-run) ==');
    lines.push(`${parsed.from} -> ${parsed.to}`);
    lines.push(`amount: ${parsed.amountStr}`);
    if (preview.route) lines.push(`route: ${preview.route}`);
    if (preview.quoteId) lines.push(`quoteId: ${preview.quoteId}`);
    if (plan?.meta?.planHash) lines.push(`planHash: ${plan.meta.planHash}`);
    if (plan?.meta?.policyHash) lines.push(`policyHash: ${plan.meta.policyHash}`);
    if (preview.runId) lines.push(`runId: ${preview.runId}`);
    lines.push('');
    lines.push('To execute, reply exactly: I_CONFIRM');
    lines.push('(expires in ~2 minutes)');

    console.log(lines.join('\n'));
    return;
  }

  if (line === 'I_CONFIRM') {
    const pending = loadPending();
    if (!pending?.planPath) {
      console.log('No pending swap. Run: swap SOL USDC 0.01');
      return;
    }
    if (pending.expiresAtMs && nowMs() > pending.expiresAtMs) {
      clearPending();
      console.log('Pending swap expired. Please run swap again.');
      return;
    }

    const exec = runPlanSummary(pending.planPath, { dryRun: false });

    // Verify the plan-run (best effort)
    let verifyOk = null;
    try {
      const cmd = `cd /home/davirain/clawd/web3AIRuntime && node scripts/w3rt_verify_run.mjs --run-id ${JSON.stringify(exec.runId)} | jq -r '.ok'`;
      verifyOk = sh(cmd).trim() === 'true';
    } catch {
      verifyOk = null;
    }

    clearPending();

    const lines = [];
    lines.push('== Swap executed ==');
    if (exec.signature) lines.push(`signature: ${exec.signature}`);
    if (exec.signature) lines.push(`solscan: https://solscan.io/tx/${exec.signature}`);
    if (exec.swapRunId) lines.push(`swapRunId: ${exec.swapRunId}`);
    if (exec.runId) lines.push(`planRunId: ${exec.runId}`);
    if (pending.planHash) lines.push(`planHash: ${pending.planHash}`);
    if (pending.policyHash) lines.push(`policyHash: ${pending.policyHash}`);
    if (verifyOk === true) lines.push('verify: OK ✅');
    else if (verifyOk === false) lines.push('verify: FAIL ❌');
    else lines.push('verify: (not available)');
    lines.push('');
    lines.push(`Receipt: receipt ${exec.runId}`);
    console.log(lines.join('\n'));
    return;
  }

  if (line.startsWith('receipt ')) {
    const rid = line.split(/\s+/)[1];
    if (!rid) {
      console.log('Usage: receipt <planRunId>');
      return;
    }
    console.log(receiptFromRunId(rid));
    return;
  }

  console.log('Unknown command. Type: help');
}

try {
  main();
} catch (e) {
  console.log(`Error: ${String(e?.message || e)}`);
}
