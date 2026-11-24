// Local emulation of the Google / GitHub / EdgeOne services Hero's original server functions call.
// The original edge-functions/*.js and cloud-functions/*.js files run unmodified; their outbound
// fetch() calls are answered here instead of by Firebase, FCM, GitHub, or the EdgeOne deploy hook.
import { createHash, randomUUID, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { isTimestamp, tsMillis, timestampFromMillis, isMap } from './values.mjs';

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// ---------- Firestore REST value encoding ----------
function toRest(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (isTimestamp(v)) return { timestampValue: new Date(tsMillis(v)).toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toRest) } };
  if (isMap(v)) return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toRest(x)])) } };
  return { nullValue: null };
}
const restFields = (data) => Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, toRest(v)]));
function fromRest(v) {
  if (!v || 'nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return timestampFromMillis(Date.parse(v.timestampValue));
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromRest);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fromRest(x)]));
  return null;
}

// ---------- RS256 JWT verification (custom tokens minted by firebase-token.js) ----------
export function verifyRs256(jwt, publicKeyPem) {
  const [h, p, s] = String(jwt || '').split('.');
  if (!h || !p || !s) return null;
  const ok = cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey(publicKeyPem), Buffer.from(s, 'base64url'));
  if (!ok) return null;
  try {
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch { return null; }
}

export function installCloudEmulator({ datastore, signer, pushHub, publicKeyPem, siteRoot, overlay, github, onDeploy, log = console }) {
  const realFetch = globalThis.fetch.bind(globalThis);
  const gitState = { head: createHash('sha1').update('hero-local-root').digest('hex'), commits: new Map(), blobs: new Map(), trees: new Map() };
  gitState.commits.set(gitState.head, { tree: 'tree-root', message: 'initial' });
  gitState.trees.set('tree-root', []);
  const sha = (s) => createHash('sha1').update(String(s) + randomUUID()).digest('hex');

  async function readBody(init, input) {
    if (init && init.body !== undefined) {
      if (typeof init.body === 'string') return init.body;
      if (init.body instanceof URLSearchParams) return init.body.toString();
      try { return await new Response(init.body).text(); } catch { return ''; }
    }
    if (input instanceof Request) return input.clone().text();
    return '';
  }

  async function handleGoogle(url, method, bodyText) {
    // OAuth service-account token exchange
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
      return jsonResponse({ access_token: `local-access-${randomUUID()}`, expires_in: 3600, token_type: 'Bearer' });
    }
    // Firebase Auth ID-token lookup (used by /api/chat)
    if (url.hostname === 'identitytoolkit.googleapis.com' && url.pathname.endsWith('/accounts:lookup')) {
      let idToken = '';
      try { idToken = JSON.parse(bodyText || '{}').idToken; } catch { /* ignore */ }
      const claims = signer.verify(idToken, 'id');
      if (!claims) return jsonResponse({ error: { code: 400, message: 'INVALID_ID_TOKEN' } }, 400);
      return jsonResponse({ users: [{ localId: claims.uid, providerUserInfo: [] }] });
    }
    // Firestore REST
    if (url.hostname === 'firestore.googleapis.com') {
      const path = decodeURIComponent(url.pathname);
      const m = path.match(/^\/v1\/projects\/([^/]+)\/databases\/\(default\)\/documents(?::runQuery|\/(.*))?$/);
      if (!m) return jsonResponse({ error: { code: 404, message: 'Not found', status: 'NOT_FOUND' } }, 404);
      const projectId = m[1];
      const docName = (p) => `projects/${projectId}/databases/(default)/documents/${p}`;
      if (path.endsWith(':runQuery') && method === 'POST') {
        const q = JSON.parse(bodyText || '{}').structuredQuery || {};
        const from = (q.from || [])[0] || {};
        let rows = from.allDescendants ? datastore.adminListGroup(from.collectionId) : datastore.adminList(from.collectionId);
        const f = q.where && q.where.fieldFilter;
        if (f && f.op === 'EQUAL') rows = rows.filter((r) => JSON.stringify(r.data[f.field.fieldPath]) === JSON.stringify(fromRest(f.value)));
        rows = rows.slice(Number(q.offset) || 0, (Number(q.offset) || 0) + (Number(q.limit) || rows.length));
        return jsonResponse(rows.map((r) => ({ document: { name: docName(r.path), fields: restFields(r.data) } })));
      }
      const docPath = m[2] || '';
      if (method === 'DELETE') { datastore.adminDelete(docPath); return jsonResponse({}); }
      const rec = datastore.adminGet(docPath);
      if (!rec) return jsonResponse({ error: { code: 404, message: `Document ${docPath} not found.`, status: 'NOT_FOUND' } }, 404);
      return jsonResponse({ name: docName(docPath), fields: restFields(rec.data) });
    }
    // Firebase Cloud Messaging HTTP v1
    if (url.hostname === 'fcm.googleapis.com' && url.pathname.endsWith('/messages:send')) {
      const message = (JSON.parse(bodyText || '{}').message) || {};
      const delivered = pushHub.send(message.token, message.data || {}, message.notification || null);
      if (!delivered) return jsonResponse({ error: { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ errorCode: 'UNREGISTERED' }] } }, 404);
      return jsonResponse({ name: `projects/local/messages/${randomUUID()}` });
    }
    return null;
  }

  function safeSitePath(rel) {
    const clean = normalize(rel).replace(/^([/\\])+/, '');
    if (clean.startsWith('..')) return null;
    return clean;
  }

  async function handleGithub(url, method, bodyText) {
    const m = decodeURIComponent(url.pathname).match(/^\/repos\/([^/]+\/[^/]+)\/(.*)$/);
    if (!m) return jsonResponse({ message: 'Not Found' }, 404);
    const rest = m[2];
    const body = bodyText ? JSON.parse(bodyText) : {};
    if (rest.startsWith('contents/') && method === 'GET') {
      const rel = safeSitePath(rest.slice('contents/'.length));
      if (!rel) return jsonResponse({ message: 'Not Found' }, 404);
      const candidates = [join(overlay, rel), join(siteRoot, rel)];
      const file = candidates.find((p) => existsSync(p));
      if (!file) return jsonResponse({ message: 'Not Found' }, 404);
      const buf = readFileSync(file);
      return jsonResponse({ type: 'file', encoding: 'base64', content: buf.toString('base64'), sha: createHash('sha1').update(buf).digest('hex'), path: rel });
    }
    if (/^git\/ref\/heads\//.test(rest) && method === 'GET') return jsonResponse({ ref: `refs/heads/${github.branch}`, object: { sha: gitState.head, type: 'commit' } });
    if (/^git\/commits\/[0-9a-f]+$/.test(rest) && method === 'GET') {
      const commitSha = rest.split('/').pop();
      const c = gitState.commits.get(commitSha);
      if (!c) return jsonResponse({ message: 'Not Found' }, 404);
      return jsonResponse({ sha: commitSha, tree: { sha: c.tree }, message: c.message });
    }
    if (rest === 'git/blobs' && method === 'POST') {
      const s = sha('blob');
      gitState.blobs.set(s, Buffer.from(body.content || '', body.encoding === 'base64' ? 'base64' : 'utf8'));
      return jsonResponse({ sha: s }, 201);
    }
    if (rest === 'git/trees' && method === 'POST') {
      const s = sha('tree');
      gitState.trees.set(s, (body.tree || []).map((e) => ({ path: e.path, sha: e.sha })));
      return jsonResponse({ sha: s }, 201);
    }
    if (rest === 'git/commits' && method === 'POST') {
      const s = sha('commit');
      gitState.commits.set(s, { tree: body.tree, message: body.message, parents: body.parents });
      return jsonResponse({ sha: s, tree: { sha: body.tree }, message: body.message }, 201);
    }
    if (/^git\/refs\/heads\//.test(rest) && method === 'PATCH') {
      const c = gitState.commits.get(body.sha);
      if (!c) return jsonResponse({ message: 'Object does not exist' }, 422);
      // "Commit" the tree's files to the local overlay so the site serves them.
      for (const entry of gitState.trees.get(c.tree) || []) {
        const rel = safeSitePath(entry.path);
        const blob = gitState.blobs.get(entry.sha);
        if (rel && blob && rel.startsWith('content/')) await github.writeOverlayFile(rel, blob);
      }
      gitState.head = body.sha;
      log.log(`[hero] local commit ${body.sha.slice(0, 7)}: ${c.message}`);
      return jsonResponse({ ref: `refs/heads/${github.branch}`, object: { sha: body.sha } });
    }
    return jsonResponse({ message: 'Not Found' }, 404);
  }

  globalThis.fetch = async function heroLocalFetch(input, init = {}) {
    let url;
    try { url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url); } catch { return realFetch(input, init); }
    const method = String((init && init.method) || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const googleHosts = ['oauth2.googleapis.com', 'identitytoolkit.googleapis.com', 'firestore.googleapis.com', 'fcm.googleapis.com'];
    if (googleHosts.includes(url.hostname)) {
      const res = await handleGoogle(url, method, await readBody(init, input));
      if (res) return res;
    }
    if (github.local && url.hostname === 'api.github.com') return handleGithub(url, method, await readBody(init, input));
    if (github.localHook && url.href === github.hookUrl) {
      await onDeploy();
      return jsonResponse({ ok: true, message: 'Local deployment started.' });
    }
    return realFetch(input, init);
  };
}
