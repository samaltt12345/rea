#!/usr/bin/env node
// Hero local server: serves the site exactly as deployed on EdgeOne Pages, runs the original
// edge/cloud functions, and replaces Firebase (Auth, Firestore, Messaging) with a local backend.
//
//   node hero/server/server.mjs            (PORT, HOST and the env vars in hero/LOCAL.md are optional)
import http from 'node:http';
import { createHash, randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { Datastore, FirestoreError } from './lib/datastore.mjs';
import { TokenSigner, newUid } from './lib/tokens.mjs';
import { PushHub } from './lib/push-hub.mjs';
import { installCloudEmulator, verifyRs256 } from './lib/cloud.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(here, '..');
const DATA_DIR = resolve(process.env.HERO_DATA_DIR || join(SITE_ROOT, '.data'));
const OVERLAY = join(DATA_DIR, 'overlay');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
mkdirSync(DATA_DIR, { recursive: true });

// ---------- persistent local secrets ----------
const secretsFile = join(DATA_DIR, 'secrets.json');
let secrets = existsSync(secretsFile) ? JSON.parse(readFileSync(secretsFile, 'utf8')) : null;
if (!secrets) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  secrets = { hmac: randomBytes(32).toString('hex'), privateKey, publicKey, vapid: randomBytes(65).toString('base64url') };
  writeFileSync(secretsFile, JSON.stringify(secrets, null, 2));
}
const stateFile = join(DATA_DIR, 'state.json');
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const saveState = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));

// ---------- environment (mirrors the EdgeOne project variables; see CONFIG.md) ----------
const FIREBASE_CONFIG = (() => {
  const src = readFileSync(join(SITE_ROOT, 'js/02-firebase-config.js'), 'utf8');
  const pick = (k) => (src.match(new RegExp(`${k}:\\s*'([^']*)'`)) || [])[1] || '';
  return { apiKey: pick('apiKey'), projectId: pick('projectId') };
})();
const SITE_ID = (readFileSync(join(SITE_ROOT, 'js/00-site-config.js'), 'utf8').match(/id:\s*'([^']+)'/) || [])[1] || 'hero-2026';
// GitHub/EdgeOne are only contacted when a real repository *and* token are configured; GITHUB_TOKEN alone
// is often present in developer shells and CI, so it never switches the server away from local mode.
const LOCAL_GITHUB = !(process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY);
const LOCAL_HOOK = !process.env.DEPLOY_WEBHOOK_URL;
const env = {
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'devaccess123',
  DEV_ACCESS: process.env.DEV_ACCESS || process.env.DEV_PASSWORD || 'devaccess123',
  FIREBASE_API_KEY: FIREBASE_CONFIG.apiKey,
  FIREBASE_PROJECT_ID: FIREBASE_CONFIG.projectId,
  FIREBASE_CLIENT_EMAIL: `hero-local@${FIREBASE_CONFIG.projectId}.iam.gserviceaccount.com`,
  FIREBASE_PRIVATE_KEY: secrets.privateKey,
  FIREBASE_WEB_PUSH_VAPID_KEY: process.env.FIREBASE_WEB_PUSH_VAPID_KEY || secrets.vapid,
  GITHUB_TOKEN: LOCAL_GITHUB ? 'local' : process.env.GITHUB_TOKEN,
  GITHUB_REPOSITORY: LOCAL_GITHUB ? 'local/hero' : process.env.GITHUB_REPOSITORY,
  DEPLOY_BRANCH: process.env.DEPLOY_BRANCH || 'main',
  DEPLOY_WEBHOOK_URL: process.env.DEPLOY_WEBHOOK_URL || 'https://hero.local/deploy-hook',
};
for (const k of ['GEMINI_API_KEY', 'GEMINI_MODEL', 'FLAPPY_TRIGGER', 'FLAPPY_BIRD_URL', 'FLAPPY_GRAVITY', 'FLAPPY_GAP']) if (process.env[k]) env[k] = process.env[k];

// ---------- core services ----------
const seed = JSON.parse(readFileSync(join(here, 'seed.json'), 'utf8'));
for (const k of Object.keys(seed.docs)) if (k.includes('{appId}')) { seed.docs[k.replace('{appId}', SITE_ID)] = seed.docs[k]; delete seed.docs[k]; }
const db = new Datastore({ file: join(DATA_DIR, 'firestore.json'), seed });
const signer = new TokenSigner(secrets.hmac);
const push = new PushHub();

const ORIGINAL_BUILD_ID = (readFileSync(join(SITE_ROOT, 'index.html'), 'utf8').match(/name="hero-build-id" content="([^"]+)"/) || [])[1] || 'local';
if (!state.buildId) { state.buildId = ORIGINAL_BUILD_ID; saveState(); }
async function localDeploy() {
  const hash = createHash('sha256').update(String(Date.now()) + randomUUID()).digest('hex').slice(0, 12);
  state.buildId = `${hash}-${randomUUID()}`;
  state.lastDeployAt = new Date().toISOString();
  saveState();
  console.log(`[hero] local deployment ${state.buildId}`);
}

installCloudEmulator({
  datastore: db, signer, pushHub: push, publicKeyPem: secrets.publicKey, siteRoot: SITE_ROOT, overlay: OVERLAY,
  github: {
    local: LOCAL_GITHUB, localHook: LOCAL_HOOK, hookUrl: env.DEPLOY_WEBHOOK_URL, branch: env.DEPLOY_BRANCH,
    writeOverlayFile: async (rel, buf) => { const p = join(OVERLAY, rel); await mkdir(dirname(p), { recursive: true }); await writeFile(p, buf); },
  },
  onDeploy: localDeploy,
});

// ---------- auth ----------
const ID_TTL = 60 * 60 * 1000;
function issueSession(uid, provider, claims = {}) {
  const base = { uid, provider, ...claims };
  return {
    uid, provider, claims: { ...claims, firebase: { sign_in_provider: provider } },
    idToken: signer.sign({ typ: 'id', ...base, iat: Date.now(), exp: Date.now() + ID_TTL }),
    refreshToken: signer.sign({ typ: 'refresh', ...base, iat: Date.now() }),
    expiresAt: Date.now() + ID_TTL,
  };
}
function authFrom(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return null;
  const t = signer.verify(m[1], 'id');
  return t ? { uid: t.uid, admin: t.admin === true, provider: t.provider } : null;
}

// ---------- realtime connections ----------
const conns = new Map(); // cid -> { res, targets: Map(tid -> target) }
function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
push.sendToConnection = (cid, message) => { const c = conns.get(cid); if (!c) return false; sse(c.res, 'push', message); return true; };

function evaluate(target) {
  if (target.kind === 'doc') { const d = db.getDoc(target.path, target.auth); return { doc: d }; }
  return { docs: db.runQuery(target.query, target.auth) };
}
function pushTarget(cid, tid, force = false) {
  const c = conns.get(cid); if (!c) return;
  const t = c.targets.get(tid); if (!t) return;
  let payload;
  try { payload = evaluate(t); } catch (e) {
    c.targets.delete(tid);
    sse(c.res, 'snap', { tid, error: { code: e.code || 'internal', message: e.message } });
    return;
  }
  const hash = createHash('sha1').update(JSON.stringify(payload)).digest('hex');
  if (!force && hash === t.hash) return;
  t.hash = hash;
  sse(c.res, 'snap', { tid, ...payload });
}
const parentOf = (p) => p.split('/').slice(0, -1).join('/');
db.onChange((paths) => {
  const parents = new Set(paths.map(parentOf));
  const set = new Set(paths);
  for (const [cid, c] of conns) {
    for (const [tid, t] of c.targets) {
      if ((t.kind === 'doc' && set.has(t.path)) || (t.kind === 'query' && parents.has(t.query.path.split('/').filter(Boolean).join('/')))) pushTarget(cid, tid);
    }
  }
});

// ---------- edge/cloud function loader ----------
const moduleCache = new Map();
async function loadFunction(file) {
  if (!moduleCache.has(file)) {
    const src = readFileSync(join(SITE_ROOT, file), 'utf8');
    moduleCache.set(file, import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`));
  }
  return moduleCache.get(file);
}
const FUNCTIONS = {
  '/api/auth': 'edge-functions/api/auth.js',
  '/api/chat': 'edge-functions/api/chat.js',
  '/api/config': 'edge-functions/api/config.js',
  '/api/deploy': 'edge-functions/api/deploy.js',
  '/api/firebase-token': 'edge-functions/api/firebase-token.js',
  '/api/push-announcement': 'edge-functions/api/push-announcement.js',
  '/api/push-config': 'edge-functions/api/push-config.js',
  '/api/build-boundaries': 'cloud-functions/api/build-boundaries.js', // Node cloud function wins over the edge route, as on EdgeOne
};

async function runFunction(file, req, res, body) {
  const mod = await loadFunction(file);
  const method = req.method.toUpperCase();
  const handler = mod[`onRequest${method[0]}${method.slice(1).toLowerCase()}`] || mod.onRequest;
  if (!handler) { res.writeHead(405, { 'Content-Type': 'text/plain' }); res.end('Method Not Allowed'); return; }
  const url = `http://${req.headers.host || 'localhost'}${req.url}`;
  const request = new Request(url, { method, headers: req.headers, body: ['GET', 'HEAD'].includes(method) ? undefined : body });
  const response = await handler({ request, env, params: {}, waitUntil: () => {} });
  const headers = Object.fromEntries(response.headers.entries());
  res.writeHead(response.status, headers);
  if (!response.body) { res.end(); return; }
  if (String(headers['content-type'] || '').includes('text/event-stream')) res.flushHeaders?.();
  Readable.fromWeb(response.body).pipe(res);
}

// ---------- static site ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.geojson': 'application/geo+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.woff2': 'font/woff2' };
const PUBLIC_DIRS = ['css', 'js', 'media', 'content'];
const PUBLIC_FILES = ['hero-push-icon.svg'];
const shimFile = join(here, 'client', 'firebase-local.js');
const shimVersion = () => createHash('sha256').update(readFileSync(shimFile)).digest('hex').slice(0, 16);

function renderIndex() {
  let html = readFileSync(join(SITE_ROOT, 'index.html'), 'utf8');
  // Swap the Firebase compat SDK for the local, API-compatible client. Everything else is byte-for-byte.
  let injected = false;
  html = html.replace(/[ \t]*<script src="https:\/\/www\.gstatic\.com\/firebasejs\/[^"]+"><\/script>\r?\n?/g, (m) => {
    if (injected) return '';
    injected = true;
    const indent = (m.match(/^[ \t]*/) || [''])[0];
    return `${indent}<script src="/__local/firebase-local.js?v=${shimVersion()}"></script>\n`;
  });
  html = html.replace(/(<meta name="hero-build-id" content=")[^"]*(")/, `$1${state.buildId}$2`);
  return html;
}
function renderServiceWorker() {
  const src = readFileSync(join(SITE_ROOT, 'firebase-messaging-sw.js'), 'utf8');
  const idx = src.indexOf("self.addEventListener('notificationclick'");
  // Notifications are shown by the page through this registration; keep the original click handling.
  return `/* Hero local push worker (Firebase Messaging is emulated by the local server). */\nself.addEventListener('install', () => self.skipWaiting());\nself.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));\n\n${idx >= 0 ? src.slice(idx) : ''}`;
}

function serveFile(req, res, filePath, cacheControl) {
  const stat = statSync(filePath);
  const type = TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': cacheControl, 'Accept-Ranges': 'bytes', 'Last-Modified': stat.mtime.toUTCString() };
  const range = req.headers.range && String(req.headers.range).match(/^bytes=(\d*)-(\d*)$/);
  if (range) {
    let start = range[1] === '' ? stat.size - Number(range[2]) : Number(range[1]);
    let end = range[1] === '' || range[2] === '' ? stat.size - 1 : Math.min(Number(range[2]), stat.size - 1);
    if (Number.isNaN(start) || start < 0) start = 0;
    if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(filePath).pipe(res);
}

function resolveStatic(pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  if (!rel || rel.startsWith('..') || rel.split(sep).some((p) => p.startsWith('.'))) return null;
  const top = rel.split(sep)[0];
  if (!PUBLIC_DIRS.includes(top) && !PUBLIC_FILES.includes(rel)) return null;
  for (const base of [OVERLAY, SITE_ROOT]) {
    const p = join(base, rel);
    if (p.startsWith(base) && existsSync(p) && statSync(p).isFile()) return { path: p, rel };
  }
  return null;
}

function cacheFor(rel, url) {
  // edgeone.json: /js/* and /css/* are immutable for a year (URLs are content-stamped).
  if ((rel.startsWith(`js${sep}`) || rel.startsWith(`css${sep}`)) && url.searchParams.has('v')) return 'public, max-age=31536000, immutable';
  if (rel.startsWith(`content${sep}`)) return 'no-cache';
  return 'public, max-age=3600';
}

// ---------- HTTP ----------
const readBody = (req, limit = 25 * 1024 * 1024) => new Promise((resolveBody, reject) => {
  const chunks = []; let size = 0;
  req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Payload too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolveBody(Buffer.concat(chunks)));
  req.on('error', reject);
});
const sendJson = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const dbError = (res, e) => {
  const status = { 'permission-denied': 403, 'not-found': 404, aborted: 409, 'invalid-argument': 400, unauthenticated: 401 }[e.code] || 500;
  if (status === 500) console.error('[hero] datastore error', e);
  sendJson(res, status, { error: { code: e.code || 'internal', message: e.message } });
};

async function handleDb(req, res, url) {
  const route = url.pathname.slice('/__db/'.length);
  if (route === 'stream' && req.method === 'GET') {
    const cid = randomUUID();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    res.write(`retry: 2000\n\n`);
    conns.set(cid, { res, targets: new Map() });
    sse(res, 'hello', { cid });
    const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15000);
    req.on('close', () => { clearInterval(ping); conns.delete(cid); push.dropConnection(cid); });
    return;
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: { code: 'method-not-allowed' } });
  let body = {};
  try { const raw = await readBody(req); body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch (e) { return sendJson(res, e.status || 400, { error: { code: 'invalid-argument', message: e.message } }); }
  const auth = authFrom(req);
  try {
    switch (route) {
      case 'auth/anonymous': return sendJson(res, 200, issueSession(newUid(), 'anonymous'));
      case 'auth/custom': {
        const payload = verifyRs256(body.customToken, secrets.publicKey);
        if (!payload || !payload.uid) return sendJson(res, 400, { error: { code: 'auth/invalid-custom-token', message: 'The custom token format is incorrect.' } });
        return sendJson(res, 200, issueSession(payload.uid, 'custom', payload.claims || {}));
      }
      case 'auth/refresh': {
        const t = signer.verify(body.refreshToken, 'refresh');
        if (!t) return sendJson(res, 400, { error: { code: 'auth/user-token-expired', message: 'The user session has expired.' } });
        const { typ, iat, exp, uid, provider, ...claims } = t;
        return sendJson(res, 200, issueSession(uid, provider, claims));
      }
      case 'get': return sendJson(res, 200, db.getDoc(body.path, auth));
      case 'query': return sendJson(res, 200, { docs: db.runQuery(body.query, auth) });
      case 'commit': return sendJson(res, 200, db.commit(body.writes, auth, body.preconditions));
      case 'listen': {
        const c = conns.get(body.cid);
        if (!c) return sendJson(res, 410, { error: { code: 'unavailable', message: 'Stream not connected.' } });
        c.targets.set(body.tid, { ...body.target, auth, hash: '' });
        pushTarget(body.cid, body.tid, true);
        return sendJson(res, 200, { ok: true });
      }
      case 'unlisten': { const c = conns.get(body.cid); if (c) c.targets.delete(body.tid); return sendJson(res, 200, { ok: true }); }
      case 'messaging/register': push.register(body.token, body.cid); return sendJson(res, 200, { ok: true });
      case 'messaging/unregister': push.unregister(body.token); return sendJson(res, 200, { ok: true });
      default: return sendJson(res, 404, { error: { code: 'not-found' } });
    }
  } catch (e) {
    if (e instanceof FirestoreError) return dbError(res, e);
    throw e;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  try {
    if (pathname.startsWith('/__db/')) return await handleDb(req, res, url);
    if (FUNCTIONS[pathname.replace(/\/$/, '')]) {
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
      return await runFunction(FUNCTIONS[pathname.replace(/\/$/, '')], req, res, body);
    }
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not_found' });
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    if (pathname === '/' || pathname === '/index.html') {
      const html = renderIndex();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      res.end(req.method === 'HEAD' ? undefined : html);
      return;
    }
    if (pathname === '/firebase-messaging-sw.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Service-Worker-Allowed': '/' });
      res.end(renderServiceWorker());
      return;
    }
    if (pathname === '/__local/firebase-local.js') return serveFile(req, res, shimFile, url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache');
    const file = resolveStatic(pathname);
    if (file) return serveFile(req, res, file.path, cacheFor(file.rel, url));
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>404</title><p>Not found</p>');
  } catch (e) {
    console.error('[hero] request failed', req.method, pathname, e);
    if (!res.headersSent) sendJson(res, e.status || 500, { ok: false, error: 'server_error' });
    else res.end();
  }
});
server.keepAliveTimeout = 65000;
server.listen(PORT, HOST, () => {
  console.log(`[hero] Hero is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`[hero] data: ${DATA_DIR}`);
  console.log(`[hero] early-access + steward password: ${process.env.DEV_ACCESS || process.env.ADMIN_PASSWORD ? '(from env)' : 'devaccess123'}`);
  if (!env.GEMINI_API_KEY) console.log('[hero] Clio: set GEMINI_API_KEY to enable AI answers.');
});
