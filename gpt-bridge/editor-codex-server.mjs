#!/usr/bin/env node
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const HOST = process.env.EDITOR_CODEX_HOST || '0.0.0.0';
const PORT = Number(process.env.EDITOR_CODEX_PORT || 8790);
const API_KEY = process.env.HYPERFRAMES_BRIDGE_API_KEY || '';
const CODEX_BIN = process.env.CODEX_BIN || (process.platform === 'win32' ? 'codex.exe' : 'codex');
const MAX_PROMPT_CHARS = Number(process.env.EDITOR_CODEX_MAX_PROMPT_CHARS || 30000);
const MAX_LOG_CHARS = Number(process.env.EDITOR_CODEX_MAX_LOG_CHARS || 160000);
const JOB_TIMEOUT_MS = Number(process.env.EDITOR_CODEX_JOB_TIMEOUT_MS || 45 * 60 * 1000);
const JOBS = new Map();

if (!API_KEY) {
  console.error('HYPERFRAMES_BRIDGE_API_KEY is required.');
  process.exit(1);
}

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body, null, 2));
}

function authorized(req) {
  return req.headers.authorization === `Bearer ${API_KEY}`;
}

async function bodyJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1000000) throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { statusCode: 400 });
  }
}

function projectSlug(value) {
  if (value == null || value === '') return null;
  const slug = String(value).trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw Object.assign(new Error('project must be a lowercase kebab-case slug'), { statusCode: 400 });
  }
  return slug;
}

function trimLog(value, chunk) {
  const next = value + chunk.toString('utf8');
  return next.length > MAX_LOG_CHARS ? next.slice(-MAX_LOG_CHARS) : next;
}

async function cwdFor(slug) {
  if (!slug) return ROOT;
  const dir = join(ROOT, 'video-projects', slug);
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) throw new Error('not a directory');
  } catch {
    throw Object.assign(new Error(`video project not found: ${slug}`), { statusCode: 404 });
  }
  return dir;
}

function buildPrompt(userPrompt, slug) {
  const target = slug ? `video-projects/${slug}` : 'the repository root';
  return [
    'You are the Codex execution layer for the HyperFrames workspace named editor.',
    'Read and obey the repository AGENTS.md and the relevant .agents/skills before making changes.',
    `Work only inside ${target} and the repository files required to complete this task.`,
    'Reuse the existing HyperFrames skills and scripts rather than inventing a parallel video pipeline.',
    'For video edits, preserve source media, create new outputs, and run the relevant preflight/lint/validators before claiming success.',
    'Do not publish, upload, or send finished media to external services unless the user explicitly requested that action and the environment permits it.',
    'Mistake removal remains review-gated: if cuts have not already been approved, produce candidates and stop before applying ambiguous cuts.',
    '',
    'USER TASK:',
    userPrompt,
  ].join('\n');
}

function startCodexJob({ prompt, slug, readOnly }) {
  const id = randomUUID();
  const job = {
    id,
    workspace: 'editor',
    project: slug,
    status: 'queued',
    sandbox: readOnly ? 'read-only' : 'workspace-write',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    stdout: '',
    stderr: '',
  };
  JOBS.set(id, job);

  void (async () => {
    const cwd = await cwdFor(slug);
    const args = [
      'exec',
      '--sandbox', readOnly ? 'read-only' : 'workspace-write',
      '--ask-for-approval', 'never',
      '--json',
      buildPrompt(prompt, slug),
    ];

    job.status = 'running';
    job.startedAt = new Date().toISOString();

    const child = spawn(CODEX_BIN, args, {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      if (job.status === 'running') {
        job.status = 'timed_out';
        job.stderr = trimLog(job.stderr, `\nCodex job exceeded ${JOB_TIMEOUT_MS}ms and was terminated.`);
        child.kill('SIGTERM');
      }
    }, JOB_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { job.stdout = trimLog(job.stdout, chunk); });
    child.stderr.on('data', (chunk) => { job.stderr = trimLog(job.stderr, chunk); });
    child.on('error', (err) => {
      clearTimeout(timer);
      job.status = 'failed';
      job.stderr = trimLog(job.stderr, `\n${err.stack || err.message}`);
      job.finishedAt = new Date().toISOString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (job.status === 'running') job.status = code === 0 ? 'completed' : 'failed';
      job.exitCode = code;
      job.finishedAt = new Date().toISOString();
    });
  })().catch((err) => {
    job.status = 'failed';
    job.stderr = trimLog(job.stderr, err.stack || err.message);
    job.finishedAt = new Date().toISOString();
  });

  return job;
}

const server = createServer(async (req, res) => {
  const requestId = randomUUID();
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, { ok: true, service: 'hyperframes-editor-codex', workspace: 'editor', requestId });
    }

    if (!authorized(req)) return send(res, 401, { error: 'unauthorized', requestId });

    if (req.method === 'POST' && path === '/v1/codex/editor/run') {
      const body = await bodyJson(req);
      const prompt = String(body.prompt || '').trim();
      if (!prompt) throw Object.assign(new Error('prompt is required'), { statusCode: 400 });
      if (prompt.length > MAX_PROMPT_CHARS) throw Object.assign(new Error('prompt is too long'), { statusCode: 413 });
      const slug = projectSlug(body.project);
      const job = startCodexJob({ prompt, slug, readOnly: body.readOnly === true });
      return send(res, 202, {
        jobId: job.id,
        status: job.status,
        workspace: 'editor',
        project: slug,
        sandbox: job.sandbox,
        requestId,
      });
    }

    const jobMatch = path.match(/^\/v1\/codex\/editor\/jobs\/([0-9a-f-]+)$/i);
    if (req.method === 'GET' && jobMatch) {
      const job = JOBS.get(jobMatch[1]);
      if (!job) throw Object.assign(new Error('job not found; jobs are stored in memory and are lost after process restart'), { statusCode: 404 });
      return send(res, 200, { ...job, requestId });
    }

    return send(res, 404, { error: 'not_found', requestId });
  } catch (err) {
    return send(res, Number(err.statusCode || 500), { error: err.message || 'internal_error', requestId });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`HyperFrames editor Codex gateway listening on http://${HOST}:${PORT}`);
});
