// A small Firestore-compatible document store persisted to a JSON file.
// Documents are keyed by their full slash path ("artifacts/hero-2026/public/data/feedback/abc").
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  clone, compareValues, valuesEqual, getField, mergeInto, applyUpdate, resolveValue, timestampFromMillis, isMap,
} from './values.mjs';
import { allowed } from './rules.mjs';

export class FirestoreError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const splitPath = (p) => String(p || '').split('/').filter(Boolean);
const parentOf = (docPath) => splitPath(docPath).slice(0, -1).join('/');

export class Datastore {
  constructor({ file, seed }) {
    this.file = file;
    this.docs = new Map(); // path -> { data, createTime, updateTime }
    this.listeners = new Set(); // fn(changedPaths: string[])
    this.saveTimer = null;
    this.clock = 0;
    this.load(seed);
  }

  load(seed) {
    let raw = null;
    if (this.file && existsSync(this.file)) {
      try { raw = JSON.parse(readFileSync(this.file, 'utf8')); } catch (e) { console.error('[hero] could not read datastore, reseeding:', e.message); }
    }
    if (!raw && seed) {
      raw = { docs: {} };
      const now = this.now();
      for (const [path, data] of Object.entries(seed.docs || {})) raw.docs[path] = { data: resolveValue(data, undefined, now), createTime: now, updateTime: now };
    }
    for (const [path, rec] of Object.entries((raw && raw.docs) || {})) this.docs.set(path, rec);
    if (raw && !existsSync(this.file || '')) this.scheduleSave(0);
  }

  scheduleSave(delay = 250) {
    if (!this.file) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), delay);
  }

  saveNow() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ docs: Object.fromEntries(this.docs) }));
    renameSync(tmp, this.file);
  }

  // Monotonic timestamps so update times always differ (used as transaction preconditions).
  now() {
    let ms = Date.now();
    const t = timestampFromMillis(ms);
    const key = t.s * 1e9 + t.n;
    if (key <= this.clock) { t.n = (this.clock % 1e9) + 1000; t.s = Math.floor(this.clock / 1e9); if (t.n >= 1e9) { t.s += 1; t.n -= 1e9; } }
    this.clock = t.s * 1e9 + t.n;
    return t;
  }

  check(op, path, auth, resource, request) {
    if (!allowed({ op, segments: splitPath(path), auth, resource, request })) {
      throw new FirestoreError('permission-denied', 'Missing or insufficient permissions.');
    }
  }

  getDoc(path, auth) {
    const rec = this.docs.get(path);
    this.check('get', path, auth, rec ? rec.data : null, null);
    return rec ? { path, data: clone(rec.data), createTime: rec.createTime, updateTime: rec.updateTime } : { path, data: null };
  }

  // query: { path, where: [[field, op, value]], orderBy: [[field, dir]], limit, limitToLast }
  runQuery(q, auth) {
    const collPath = splitPath(q.path).join('/');
    const depth = splitPath(collPath).length + 1;
    // List rule check uses a synthetic doc path in the collection.
    this.check('list', `${collPath}/__list__`, auth, null, null);
    let rows = [];
    for (const [path, rec] of this.docs) {
      if (parentOf(path) !== collPath || splitPath(path).length !== depth) continue;
      rows.push({ path, data: rec.data, createTime: rec.createTime, updateTime: rec.updateTime });
    }
    for (const [field, op, value] of q.where || []) rows = rows.filter((r) => matches(getField(r.data, field), op, value, r.path, field));
    const orders = (q.orderBy || []).slice();
    for (const [field] of orders) rows = rows.filter((r) => field === '__name__' || getField(r.data, field) !== undefined);
    rows.sort((a, b) => {
      for (const [field, dir] of orders) {
        const av = field === '__name__' ? a.path : getField(a.data, field);
        const bv = field === '__name__' ? b.path : getField(b.data, field);
        const c = compareValues(av, bv);
        if (c) return dir === 'desc' ? -c : c;
      }
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    if (Number.isInteger(q.limit) && q.limit >= 0) rows = rows.slice(0, q.limit);
    if (Number.isInteger(q.limitToLast) && q.limitToLast >= 0) rows = rows.slice(Math.max(0, rows.length - q.limitToLast));
    return rows.map((r) => ({ path: r.path, data: clone(r.data), createTime: r.createTime, updateTime: r.updateTime }));
  }

  // writes: [{ type: 'set'|'update'|'delete', path, data, merge }]
  // preconditions: [{ path, updateTime | null }]  (null means "must not exist")
  commit(writes, auth, preconditions = []) {
    for (const pre of preconditions || []) {
      const rec = this.docs.get(pre.path);
      const cur = rec ? rec.updateTime : null;
      const same = (!cur && !pre.updateTime) || (cur && pre.updateTime && cur.s === pre.updateTime.s && cur.n === pre.updateTime.n);
      if (!same) throw new FirestoreError('aborted', 'Transaction conflict; please retry.');
    }
    const now = this.now();
    const staged = new Map();
    const current = (path) => (staged.has(path) ? staged.get(path) : (this.docs.get(path) || null));
    for (const w of writes || []) {
      const path = splitPath(w.path).join('/');
      if (splitPath(path).length % 2 !== 0) throw new FirestoreError('invalid-argument', `Invalid document reference ${path}.`);
      const prev = current(path);
      const before = prev ? prev.data : null;
      if (w.type === 'delete') {
        if (before) this.check('delete', path, auth, before, null);
        staged.set(path, null);
        continue;
      }
      let after;
      if (w.type === 'update') {
        if (!before) throw new FirestoreError('not-found', `No document to update: ${path}`);
        after = applyUpdate(before, w.data, now);
      } else if (w.merge) {
        after = mergeInto(before || {}, w.data, now);
      } else {
        after = resolveValue(w.data || {}, before || undefined, now);
      }
      if (!isMap(after)) throw new FirestoreError('invalid-argument', 'Document data must be an object.');
      this.check(before ? 'update' : 'create', path, auth, before, after);
      staged.set(path, { data: after, createTime: prev ? prev.createTime : now, updateTime: now });
    }
    const changed = [];
    for (const [path, rec] of staged) {
      const prev = this.docs.get(path);
      if (rec === null) { if (prev) { this.docs.delete(path); changed.push(path); } continue; }
      this.docs.set(path, rec);
      if (!prev || !valuesEqual(prev.data, rec.data)) changed.push(path);
    }
    if (staged.size) this.scheduleSave();
    if (changed.length) for (const fn of this.listeners) { try { fn(changed); } catch (e) { console.error(e); } }
    return { commitTime: now };
  }

  // Server-side helpers (bypass rules; used by local API endpoints).
  adminList(collPath) {
    const depth = splitPath(collPath).length + 1;
    return [...this.docs].filter(([p]) => parentOf(p) === collPath && splitPath(p).length === depth).map(([path, rec]) => ({ path, data: clone(rec.data), updateTime: rec.updateTime, createTime: rec.createTime }));
  }
  adminListGroup(collectionId) {
    return [...this.docs].filter(([p]) => { const s = splitPath(p); return s[s.length - 2] === collectionId; }).map(([path, rec]) => ({ path, data: clone(rec.data), updateTime: rec.updateTime, createTime: rec.createTime }));
  }
  adminGet(path) { const rec = this.docs.get(path); return rec ? { path, data: clone(rec.data), updateTime: rec.updateTime, createTime: rec.createTime } : null; }
  adminDelete(path) { this.commit([{ type: 'delete', path }], { uid: 'admin', admin: true, provider: 'custom' }); }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}

function matches(v, op, value, path, field) {
  if (field === '__name__') v = path;
  switch (op) {
    case '==': return valuesEqual(v, value);
    case '!=': return v !== undefined && !valuesEqual(v, value);
    case '<': return v !== undefined && sameKind(v, value) && compareValues(v, value) < 0;
    case '<=': return v !== undefined && sameKind(v, value) && compareValues(v, value) <= 0;
    case '>': return v !== undefined && sameKind(v, value) && compareValues(v, value) > 0;
    case '>=': return v !== undefined && sameKind(v, value) && compareValues(v, value) >= 0;
    case 'in': return Array.isArray(value) && value.some((x) => valuesEqual(v, x));
    case 'not-in': return v !== undefined && Array.isArray(value) && !value.some((x) => valuesEqual(v, x));
    case 'array-contains': return Array.isArray(v) && v.some((x) => valuesEqual(x, value));
    case 'array-contains-any': return Array.isArray(v) && Array.isArray(value) && v.some((x) => value.some((y) => valuesEqual(x, y)));
    default: return false;
  }
}
const kind = (v) => (v === null ? 'null' : typeof v === 'object' ? (v.__t === 'ts' ? 'ts' : Array.isArray(v) ? 'array' : 'map') : typeof v);
const sameKind = (a, b) => kind(a) === kind(b);
