#!/usr/bin/env node
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, readdir, stat, writeFile, unlink } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BRIDGE_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(BRIDGE_DIR, '..');
const HOST = process.env.HYPERFRAMES_BRIDGE_HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || process.env.HYPERFRAMES_BRIDGE_PORT || 8787);
const API_KEY = process.env.HYPERFRAMES_BRIDGE_API_KEY || '';
const ALLOW_UNAUTH = process.env.HYPERFRAMES_ALLOW_UNAUTHENTICATED === '1';
const MAX_JSON_BYTES = Number(process.env.HYPERFRAMES_MAX_JSON_BYTES || 1_000_000);
const MAX_MEDIA_BYTES = Number(process.env.HYPERFRAMES_MAX_MEDIA_BYTES || 250 * 1024 * 1024);
const MAX_LOG_CHARS = Number(process.env.HYPERFRAMES_MAX_LOG_CHARS || 120_000);
const JOB_TIMEOUT_MS = Number(process.env.HYPERFRAMES_JOB_TIMEOUT_MS || 30 * 60 * 1000);
const ALLOWED_MEDIA_HOSTS = (process.env.HYPERFRAMES_ALLOWED_MEDIA_HOSTS || '')
  .split(',')
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);

if (!API_KEY && !ALLOW_UNAUTH) {
  console.error('HYPERFRAMES_BRIDGE_API_KEY is required. Set HYPERFRAMES_ALLOW_UNAUTHENTICATED=1 only for local development.');
  process.exit(1);
}

const JOBS = new Map();
const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function isAuthorized(req) {
  if (ALLOW_UNAUTH) return true;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${API_KEY}`;
}

async function parseJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw Object.assign(new Error('JSON body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
  }
}

function normalizeProjectSlug(value) {
  const slug = String(value || '').trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw Object.assign(new Error('project must be a lowercase kebab-case slug'), { statusCode: 400 });
  }
  return slug;
}

function normalizeProjectRelativePath(value, { extensions = null } = {}) {
  const input = String(value || '').replace(/\\/g, '/').trim();
  if (!input || input.startsWith('/') || input.includes('\0')) {
    throw Object.assign(new Error('path must be a non-empty relative project path'), { statusCode: 400 });
  }
  const pieces = input.split('/');
  if (pieces.some((p) => !p || p === '.' || p === '..')) {
    throw Object.assign(new Error('path cannot contain empty, dot, or parent segments'), { statusCode: 400 });
  }
  if (extensions && !extensions.has(extname(input).toLowerCase())) {
    throw Object.assign(new Error(`unsupported file extension: ${extname(input) || '(none)'}`), { statusCode: 400 });
  }
  return input;
}

function projectDir(slug) {
  return join(ROOT, 'video-projects', normalizeProjectSlug(slug));
}

async function requireProject(slug) {
  const dir = projectDir(slug);
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) throw new Error('not directory');
  } catch {
    throw Object.assign(new Error(`project not found: ${slug}`), { statusCode: 404 });
  }
  return dir;
}

function safeWithin(baseDir, relPath) {
  const full = resolve(baseDir, relPath);
  const rel = relative(baseDir, full);
  if (rel.startsWith('..') || rel === '..' || rel.includes(`..${sep}`)) {
    throw Object.assign(new Error('path escapes allowed directory'), { statusCode: 400 });
  }
  return full;
}

function appendLog(current, chunk) {
  const next = current + chunk.toString('utf8');
  return next.length > MAX_LOG_CHARS ? next.slice(next.length - MAX_LOG_CHARS) : next;
}

function startJob({ type, project, command, args, cwd }) {
  const id = randomUUID();
  const job = {
    id,
    type,
    project,
    status: 'running',
    command: [command, ...args].join(' '),
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    stdout: '',
    stderr: '',
  };
  JOBS.set(id, job);

  const child = spawn(command, args, {
    cwd,
    env: process.env,
    shell: false,
    windowsHide: true,
  });

  const timer = setTimeout(() => {
    if (job.status === 'running') {
      job.status = 'timed_out';
      job.stderr = appendLog(job.stderr, `\nJob exceeded ${JOB_TIMEOUT_MS}ms and was terminated.`);
      child.kill('SIGTERM');
    }
  }, JOB_TIMEOUT_MS);

  child.stdout.on('data', (chunk) => { job.stdout = appendLog(job.stdout, chunk); });
  child.stderr.on('data', (chunk) => { job.stderr = appendLog(job.stderr, chunk); });
  child.on('error', (err) => {
    clearTimeout(timer);
    job.status = 'failed';
    job.stderr = appendLog(job.stderr, `\n${err.stack || err.message}`);
    job.finishedAt = new Date().toISOString();
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (job.status === 'running') job.status = code === 0 ? 'completed' : 'failed';
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
  });

  return job;
}

async function runCommand({ command, args, cwd, timeoutMs = 120_000 }) {
  return await new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env: process.env, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      settled = true;
      resolvePromise({ ok: false, exitCode: null, timedOut: true, stdout, stderr: appendLog(stderr, '\nCommand timed out.') });
    }, timeoutMs);
    child.stdout.on('data', (c) => { stdout = appendLog(stdout, c); });
    child.stderr.on('data', (c) => { stderr = appendLog(stderr, c); });
    child.on('error', (err) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolvePromise({ ok: false, exitCode: null, timedOut: false, stdout, stderr: appendLog(stderr, err.stack || err.message) });
    });
    child.on('close', (code) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolvePromise({ ok: code === 0, exitCode: code, timedOut: false, stdout, stderr });
    });
  });
}

async function listSkills() {
  const skillsDir = join(ROOT, '.claude', 'skills');
  const names = (await readdir(skillsDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const skills = [];
  for (const name of names) {
    try {
      const content = await readFile(join(skillsDir, name, 'SKILL.md'), 'utf8');
      const description = content.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1] || '';
      skills.push({ name, description });
    } catch {
      skills.push({ name, description: '' });
    }
  }
  return skills;
}

async function getSkill(name) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw Object.assign(new Error('invalid skill name'), { statusCode: 400 });
  const file = join(ROOT, '.claude', 'skills', name, 'SKILL.md');
  try {
    return await readFile(file, 'utf8');
  } catch {
    throw Object.assign(new Error(`skill not found: ${name}`), { statusCode: 404 });
  }
}

async function loadRegistry() {
  return JSON.parse(await readFile(join(ROOT, 'style-library', 'registry.json'), 'utf8'));
}

function flattenCards(registry) {
  const cards = [];
  for (const style of registry.styles || []) {
    for (const card of style.cards || []) {
      cards.push({
        id: card.id,
        style: card.style,
        styleName: style.name,
        tier: card.tier,
        purpose: card.purpose,
        file: card.file,
        slots: card.slots || [],
        duration: card.duration || null,
        preview: card.preview || null,
      });
    }
  }
  return cards;
}

function hostAllowed(hostname) {
  if (!ALLOWED_MEDIA_HOSTS.length) return false;
  const host = hostname.toLowerCase();
  return ALLOWED_MEDIA_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

async function fetchAllowedUrl(inputUrl, maxRedirects = 5) {
  let current = new URL(inputUrl);
  for (let i = 0; i <= maxRedirects; i++) {
    if (current.protocol !== 'https:') throw Object.assign(new Error('media URL must use https'), { statusCode: 400 });
    if (!hostAllowed(current.hostname)) {
      throw Object.assign(new Error(`media host is not allowed: ${current.hostname}`), { statusCode: 403 });
    }
    const response = await fetch(current, { redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw Object.assign(new Error('redirect without location'), { statusCode: 502 });
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw Object.assign(new Error(`media download failed with HTTP ${response.status}`), { statusCode: 502 });
    return response;
  }
  throw Object.assign(new Error('too many media redirects'), { statusCode: 502 });
}

async function importMedia(project, body) {
  const dir = await requireProject(project);
  const sourceUrl = String(body.sourceUrl || '');
  const requestedName = body.filename ? String(body.filename) : basename(new URL(sourceUrl).pathname || 'media.bin');
  const allowedExtensions = new Set(['.mp4', '.mov', '.mkv', '.webm', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus']);
  const fileName = normalizeProjectRelativePath(requestedName, { extensions: allowedExtensions });
  if (fileName.includes('/')) throw Object.assign(new Error('filename cannot contain folders'), { statusCode: 400 });
  const assetsDir = join(dir, 'assets');
  await mkdir(assetsDir, { recursive: true });
  const dest = safeWithin(assetsDir, fileName);
  const response = await fetchAllowedUrl(sourceUrl);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared && declared > MAX_MEDIA_BYTES) throw Object.assign(new Error('media exceeds configured size limit'), { statusCode: 413 });
  let seen = 0;
  const limiter = new Transform({
    transform(chunk, enc, cb) {
      seen += chunk.length;
      if (seen > MAX_MEDIA_BYTES) cb(new Error('media exceeds configured size limit'));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(dest, { flags: 'wx' }));
  } catch (err) {
    await unlink(dest).catch(() => {});
    if (err?.code === 'EEXIST') throw Object.assign(new Error(`asset already exists: ${fileName}`), { statusCode: 409 });
    throw err;
  }
  return { path: `assets/${fileName}`, bytes: seen };
}

async function handle(req, res) {
  const requestId = randomUUID();
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && path === '/health') {
      return json(res, 200, { ok: true, service: 'hyperframes-gpt-bridge', version: 1, requestId });
    }

    if (!isAuthorized(req)) return json(res, 401, { error: 'unauthorized', requestId });

    if (req.method === 'GET' && path === '/v1/capabilities') {
      const registry = await loadRegistry();
      return json(res, 200, {
        service: 'hyperframes-gpt-bridge',
        repoRoot: ROOT,
        capabilities: ['skills', 'styles', 'project-create', 'project-files', 'media-import', 'preflight', 'lint', 'beat-validation', 'silence-cut', 'mistake-detection', 'mistake-apply', 'transcription', 'render', 'doctor'],
        styleCount: registry.styleCount,
        cardCount: registry.cardCount,
        requirements: ['Node.js >= 22', 'FFmpeg/ffprobe', 'Chrome or Chromium', 'npm ci completed'],
        requestId,
      });
    }

    if (req.method === 'GET' && path === '/v1/skills') {
      return json(res, 200, { skills: await listSkills(), requestId });
    }

    const skillMatch = path.match(/^\/v1\/skills\/([a-z0-9-]+)$/);
    if (req.method === 'GET' && skillMatch) {
      return json(res, 200, { name: skillMatch[1], content: await getSkill(skillMatch[1]), requestId });
    }

    if (req.method === 'GET' && path === '/v1/styles') {
      const registry = await loadRegistry();
      const q = (url.searchParams.get('query') || '').trim().toLowerCase();
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 20), 1), 100);
      let cards = flattenCards(registry);
      if (q) cards = cards.filter((c) => JSON.stringify(c).toLowerCase().includes(q));
      return json(res, 200, { total: cards.length, cards: cards.slice(0, limit), requestId });
    }

    const cardMatch = path.match(/^\/v1\/cards\/(.+)$/);
    if (req.method === 'GET' && cardMatch) {
      const cardId = decodeURIComponent(cardMatch[1]);
      const registry = await loadRegistry();
      const card = flattenCards(registry).find((c) => c.id === cardId);
      if (!card) throw Object.assign(new Error(`card not found: ${cardId}`), { statusCode: 404 });
      const content = await readFile(join(ROOT, 'style-library', card.file), 'utf8');
      return json(res, 200, { card, content, requestId });
    }

    if (req.method === 'GET' && path === '/v1/projects') {
      const base = join(ROOT, 'video-projects');
      const projects = (await readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
      return json(res, 200, { projects, requestId });
    }

    if (req.method === 'POST' && path === '/v1/projects') {
      const body = await parseJson(req);
      const slug = normalizeProjectSlug(body.project);
      const result = await runCommand({ command: process.execPath, args: [join(ROOT, 'scripts', 'new-video.mjs'), slug], cwd: ROOT });
      return json(res, result.ok ? 201 : 400, { project: slug, ...result, requestId });
    }

    const fileMatch = path.match(/^\/v1\/projects\/([a-z0-9-]+)\/file$/);
    if (fileMatch && req.method === 'GET') {
      const dir = await requireProject(fileMatch[1]);
      const rel = normalizeProjectRelativePath(url.searchParams.get('path') || 'index.html');
      const file = safeWithin(dir, rel);
      const content = await readFile(file, 'utf8').catch(() => { throw Object.assign(new Error(`file not found: ${rel}`), { statusCode: 404 }); });
      return json(res, 200, { project: fileMatch[1], path: rel, content, requestId });
    }

    if (fileMatch && req.method === 'PUT') {
      const dir = await requireProject(fileMatch[1]);
      const body = await parseJson(req);
      const allowedExtensions = new Set(['.html', '.css', '.js', '.json', '.md', '.txt', '.vtt', '.srt']);
      const rel = normalizeProjectRelativePath(body.path, { extensions: allowedExtensions });
      const file = safeWithin(dir, rel);
      const content = String(body.content ?? '');
      if (Buffer.byteLength(content, 'utf8') > MAX_JSON_BYTES) throw Object.assign(new Error('file content too large'), { statusCode: 413 });
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content, 'utf8');
      return json(res, 200, { project: fileMatch[1], path: rel, bytes: Buffer.byteLength(content, 'utf8'), requestId });
    }

    const assetMatch = path.match(/^\/v1\/projects\/([a-z0-9-]+)\/assets\/from-url$/);
    if (req.method === 'POST' && assetMatch) {
      const body = await parseJson(req);
      const result = await importMedia(assetMatch[1], body);
      return json(res, 201, { project: assetMatch[1], ...result, requestId });
    }

    const opMatch = path.match(/^\/v1\/projects\/([a-z0-9-]+)\/(preflight|lint|validate-beats|cut-silences|find-mistakes|apply-mistakes|transcribe|render)$/);
    if (req.method === 'POST' && opMatch) {
      const project = opMatch[1];
      const operation = opMatch[2];
      const dir = await requireProject(project);
      const body = await parseJson(req);

      if (operation === 'preflight') {
        const result = await runCommand({ command: process.execPath, args: [join(ROOT, 'scripts', 'preflight.mjs'), dir], cwd: ROOT });
        return json(res, result.ok ? 200 : 422, { project, operation, ...result, requestId });
      }

      if (operation === 'lint') {
        const result = await runCommand({ command: npxCommand, args: ['hyperframes', 'lint', '--json'], cwd: dir });
        return json(res, result.ok ? 200 : 422, { project, operation, ...result, requestId });
      }

      if (operation === 'validate-beats') {
        const result = await runCommand({ command: process.execPath, args: [join(ROOT, 'scripts', 'validate-beat-sync.mjs'), dir], cwd: ROOT });
        return json(res, result.ok ? 200 : 422, { project, operation, ...result, requestId });
      }

      if (operation === 'cut-silences') {
        const transcriptRel = normalizeProjectRelativePath(body.transcript);
        const transcript = safeWithin(dir, transcriptRel);
        await access(transcript).catch(() => { throw Object.assign(new Error(`transcript not found: ${transcriptRel}`), { statusCode: 404 }); });
        const args = [join(ROOT, '.claude', 'skills', 'cut-silences', 'scripts', 'cut-silences.mjs'), transcript, '--out-dir', join(dir, 'assets')];
        if (body.video) {
          const videoRel = normalizeProjectRelativePath(body.video);
          args.push('--video', safeWithin(dir, videoRel));
        }
        if (body.gap != null) args.push('--gap', String(Number(body.gap)));
        if (body.headPad != null) args.push('--head-pad', String(Number(body.headPad)));
        if (body.tailPad != null) args.push('--tail-pad', String(Number(body.tailPad)));
        if (body.apply === true) {
          if (!body.video) throw Object.assign(new Error('video is required when apply=true'), { statusCode: 400 });
          args.push('--apply');
          const outputName = String(body.output || 'edited-silenced.mp4');
          const outputRel = normalizeProjectRelativePath(`assets/${basename(outputName)}`, { extensions: new Set(['.mp4', '.mov', '.mkv', '.webm']) });
          args.push('--output', safeWithin(dir, outputRel));
        }
        const job = startJob({ type: 'cut-silences', project, command: process.execPath, args, cwd: ROOT });
        return json(res, 202, { jobId: job.id, status: job.status, requestId });
      }

      if (operation === 'find-mistakes') {
        const transcriptRel = normalizeProjectRelativePath(body.transcript);
        const transcript = safeWithin(dir, transcriptRel);
        const args = [join(ROOT, '.claude', 'skills', 'cut-mistakes', 'scripts', 'find-cut-candidates.mjs'), transcript, '--out-dir', join(dir, 'assets')];
        const job = startJob({ type: 'find-mistakes', project, command: process.execPath, args, cwd: ROOT });
        return json(res, 202, { jobId: job.id, status: job.status, requestId });
      }

      if (operation === 'apply-mistakes') {
        const transcriptRel = normalizeProjectRelativePath(body.transcript);
        const cutsRel = normalizeProjectRelativePath(body.cuts);
        const videoRel = normalizeProjectRelativePath(body.video);
        const outputName = basename(String(body.output || 'edited-clean.mp4'));
        const args = [
          join(ROOT, '.claude', 'skills', 'cut-mistakes', 'scripts', 'apply-cuts.mjs'),
          safeWithin(dir, transcriptRel),
          '--cuts', safeWithin(dir, cutsRel),
          '--video', safeWithin(dir, videoRel),
          '--output', safeWithin(dir, `assets/${outputName}`),
        ];
        if (body.apply !== false) args.push('--apply');
        const job = startJob({ type: 'apply-mistakes', project, command: process.execPath, args, cwd: ROOT });
        return json(res, 202, { jobId: job.id, status: job.status, requestId });
      }

      if (operation === 'transcribe') {
        const mediaRel = normalizeProjectRelativePath(body.media);
        const media = safeWithin(dir, mediaRel);
        const args = ['hyperframes', 'transcribe', media];
        if (body.model) args.push('--model', String(body.model));
        if (body.language) args.push('--language', String(body.language));
        const job = startJob({ type: 'transcribe', project, command: npxCommand, args, cwd: dir });
        return json(res, 202, { jobId: job.id, status: job.status, requestId });
      }

      if (operation === 'render') {
        const quality = ['draft', 'standard', 'high'].includes(body.quality) ? body.quality : 'draft';
        const fps = [24, 30, 60].includes(Number(body.fps)) ? Number(body.fps) : 30;
        const format = ['mp4', 'webm'].includes(body.format) ? body.format : 'mp4';
        const outputBase = basename(String(body.output || `gpt-render.${format}`));
        const output = safeWithin(join(dir, 'renders'), outputBase);
        await mkdir(join(dir, 'renders'), { recursive: true });
        const args = ['hyperframes', 'render', '--quality', quality, '--fps', String(fps), '--format', format, '--output', output];
        if (body.workers != null) {
          const workers = Number(body.workers);
          if (!Number.isInteger(workers) || workers < 1 || workers > 8) throw Object.assign(new Error('workers must be an integer from 1 to 8'), { statusCode: 400 });
          args.push('--workers', String(workers));
        }
        if (body.strict === true) args.push('--strict');
        const job = startJob({ type: 'render', project, command: npxCommand, args, cwd: dir });
        return json(res, 202, { jobId: job.id, status: job.status, output: `renders/${outputBase}`, requestId });
      }
    }

    if (req.method === 'POST' && path === '/v1/doctor') {
      const result = await runCommand({ command: npxCommand, args: ['hyperframes', 'doctor'], cwd: ROOT });
      return json(res, result.ok ? 200 : 422, { operation: 'doctor', ...result, requestId });
    }

    const jobMatch = path.match(/^\/v1\/jobs\/([0-9a-f-]+)$/i);
    if (req.method === 'GET' && jobMatch) {
      const job = JOBS.get(jobMatch[1]);
      if (!job) throw Object.assign(new Error('job not found (jobs are stored in memory and disappear after server restart)'), { statusCode: 404 });
      return json(res, 200, { ...job, requestId });
    }

    return json(res, 404, { error: 'not_found', requestId });
  } catch (err) {
    const status = Number(err.statusCode || 500);
    return json(res, status, { error: err.message || 'internal_error', requestId });
  }
}

const server = createServer(handle);
server.listen(PORT, HOST, () => {
  console.log(`HyperFrames GPT bridge listening on http://${HOST}:${PORT}`);
});
