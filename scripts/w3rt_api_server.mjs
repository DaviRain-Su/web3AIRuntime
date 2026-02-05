#!/usr/bin/env node
/**
 * w3rt_api_server.mjs
 * Minimal HTTP API that exposes w3rt scheduler + plan runner.
 *
 * Default: binds to 127.0.0.1 only.
 *
 * Endpoints:
 * - POST /compile  { workflowJson: object } -> { plan, explain }
 * - POST /dryrun   { plan: object } -> { summary, raw? }
 * - POST /run      { plan: object, confirm: string } -> executes (requires confirm === I_CONFIRM)
 * - GET  /artifact/:runId -> swap.json
 *
 * Notes:
 * - compile uses ocaml-scheduler (opam switch w3rt-ocaml)
 * - dryrun/run uses node scripts/w3rt_plan_run.mjs
 */

import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';

const HOST = process.env.W3RT_API_HOST || '127.0.0.1';
const PORT = Number(process.env.W3RT_API_PORT || 8787);
const CONFIRM = process.env.W3RT_CONFIRM_PHRASE || 'I_CONFIRM';

function w3rtDir() {
  return process.env.W3RT_DIR || join(os.homedir(), '.w3rt');
}

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function text(res, code, body) {
  res.writeHead(code, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

function sh(cmd, env = {}) {
  const res = spawnSync('bash', ['-lc', cmd], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    maxBuffer: 10 * 1024 * 1024,
  });
  return res;
}

function ensureTmp() {
  const d = join(w3rtDir(), 'tmp');
  mkdirSync(d, { recursive: true });
  return d;
}

function ocamlEnvPrefix() {
  // Use local opam installed earlier.
  return 'export PATH="$HOME/.local/bin:$PATH"; eval "$(opam env --switch=w3rt-ocaml --set-switch)";';
}

function loadPolicySnapshot() {
  try {
    const cfgPath = join(w3rtDir(), 'config.yaml');
    if (!existsSync(cfgPath)) return null;
    const cfg = yaml.load(readFileSync(cfgPath, 'utf-8')) || {};
    return cfg.policy || null;
  } catch {
    return null;
  }
}

function compileWorkflow(workflowObj) {
  const tmp = ensureTmp();
  const wfPath = join(tmp, `wf_${Date.now()}.json`);
  const planPath = join(tmp, `plan_${Date.now()}.json`);
  writeFileSync(wfPath, JSON.stringify(workflowObj, null, 2));

  const prefix = ocamlEnvPrefix();

  // explain
  let r = sh(`${prefix} cd /home/davirain/clawd/web3AIRuntime/ocaml-scheduler && opam exec -- dune exec -- w3rt-scheduler explain ${JSON.stringify(wfPath)}`);
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || '').trim().slice(0, 5000));
  }
  const explain = (r.stdout || '').trim();

  // compile (+ attach policy snapshot if present)
  const policy = loadPolicySnapshot();
  let policyArg = '';
  if (policy) {
    const policyPath = join(tmp, `policy_${Date.now()}.json`);
    writeFileSync(policyPath, JSON.stringify(policy, null, 2));
    policyArg = ` --policy ${JSON.stringify(policyPath)}`;
  }

  r = sh(`${prefix} cd /home/davirain/clawd/web3AIRuntime/ocaml-scheduler && opam exec -- dune exec -- w3rt-scheduler compile ${JSON.stringify(wfPath)} --out ${JSON.stringify(planPath)}${policyArg}`);
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || '').trim().slice(0, 5000));
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
  return { plan, explain };
}

function runPlan(planObj, { dryRun }) {
  const tmp = ensureTmp();
  const planPath = join(tmp, `plan_${Date.now()}.json`);
  writeFileSync(planPath, JSON.stringify(planObj, null, 2));

  const args = [`cd /home/davirain/clawd/web3AIRuntime && node scripts/w3rt_plan_run.mjs --plan ${JSON.stringify(planPath)} --summary`];
  if (dryRun) args.push('--dry-run');

  const r = sh(args.join(' '), { W3RT_DIR: w3rtDir() });
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || '').trim().slice(0, 5000));
  }
  const summary = (r.stdout || '').trim();

  // extract runId from summary lines: "runId: <id>"
  const m = summary.match(/\brunId:\s*(\S+)/);
  const runId = m ? m[1] : null;

  return { summary, runId };
}

function getArtifact(runId) {
  const p = join(w3rtDir(), 'runs', runId, 'swap.json');
  if (!existsSync(p)) throw new Error(`artifact not found: ${p}`);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function getRun(runId) {
  const p = join(w3rtDir(), 'runs', runId, 'run.json');
  if (!existsSync(p)) throw new Error(`run not found: ${p}`);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, w3rtDir: w3rtDir() });
    }

    if (req.method === 'POST' && url.pathname === '/compile') {
      const body = await readBody(req);
      if (!body?.workflowJson) return json(res, 400, { ok: false, error: 'missing workflowJson' });
      const out = compileWorkflow(body.workflowJson);
      return json(res, 200, { ok: true, ...out });
    }

    if (req.method === 'POST' && url.pathname === '/dryrun') {
      const body = await readBody(req);
      if (!body?.plan) return json(res, 400, { ok: false, error: 'missing plan' });
      const out = runPlan(body.plan, { dryRun: true });
      return json(res, 200, { ok: true, ...out });
    }

    if (req.method === 'POST' && url.pathname === '/run') {
      const body = await readBody(req);
      if (!body?.plan) return json(res, 400, { ok: false, error: 'missing plan' });
      if (String(body.confirm || '') !== CONFIRM) {
        return json(res, 403, { ok: false, error: `missing/invalid confirm (must equal ${CONFIRM})` });
      }
      const out = runPlan(body.plan, { dryRun: false });
      return json(res, 200, { ok: true, ...out });
    }

    const m = url.pathname.match(/^\/artifact\/(.+)$/);
    if (req.method === 'GET' && m) {
      const runId = decodeURIComponent(m[1]);
      const artifact = getArtifact(runId);
      return json(res, 200, { ok: true, artifact });
    }

    const m2 = url.pathname.match(/^\/run\/(.+)$/);
    if (req.method === 'GET' && m2) {
      const runId = decodeURIComponent(m2[1]);
      const runObj = getRun(runId);
      return json(res, 200, { ok: true, run: runObj });
    }

    return text(res, 404, 'not found');
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.error(`w3rt-api listening on http://${HOST}:${PORT} (w3rtDir=${w3rtDir()})`);
});
