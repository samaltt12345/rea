/*
 * Hero local Firebase client.
 * A drop-in replacement for the Firebase v11 compat SDK scripts (app, auth, firestore, messaging)
 * that Hero loads from gstatic.com. It exposes the same `firebase` global API surface Hero uses and
 * talks to the local Hero server (/__db/*) instead of Google's services.
 */
(function () {
  'use strict';
  const API = '/__db';
  const SDK_VERSION = '11.6.1';

  // ------------------------------------------------------------------ errors
  class FirebaseError extends Error {
    constructor(code, message) {
      super(message || code);
      this.code = code;
      this.name = 'FirebaseError';
    }
  }

  // ------------------------------------------------------------------ values
  class Timestamp {
    constructor(seconds, nanoseconds) {
      this.seconds = Math.floor(Number(seconds) || 0);
      this.nanoseconds = Math.floor(Number(nanoseconds) || 0);
    }
    static now() { return Timestamp.fromMillis(Date.now()); }
    static fromDate(date) { return Timestamp.fromMillis(date.getTime()); }
    static fromMillis(ms) { const s = Math.floor(ms / 1000); return new Timestamp(s, Math.round((ms - s * 1000) * 1e6)); }
    toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
    toDate() { return new Date(this.toMillis()); }
    isEqual(o) { return o instanceof Timestamp && o.seconds === this.seconds && o.nanoseconds === this.nanoseconds; }
    valueOf() { return String(this.seconds + 1e11).padStart(12, '0') + '.' + String(this.nanoseconds).padStart(9, '0'); }
    toString() { return `Timestamp(seconds=${this.seconds}, nanoseconds=${this.nanoseconds})`; }
    toJSON() { return { seconds: this.seconds, nanoseconds: this.nanoseconds }; }
  }

  class FieldValue {
    constructor(kind, value) { this._kind = kind; this._value = value; }
    static serverTimestamp() { return new FieldValue('serverTimestamp'); }
    static delete() { return new FieldValue('delete'); }
    static increment(n) { return new FieldValue('increment', Number(n)); }
    static arrayUnion(...items) { return new FieldValue('arrayUnion', items); }
    static arrayRemove(...items) { return new FieldValue('arrayRemove', items); }
    isEqual(o) { return o instanceof FieldValue && o._kind === this._kind && JSON.stringify(o._value) === JSON.stringify(this._value); }
  }

  class GeoPoint {
    constructor(latitude, longitude) { this.latitude = latitude; this.longitude = longitude; }
    isEqual(o) { return o instanceof GeoPoint && o.latitude === this.latitude && o.longitude === this.longitude; }
  }

  class FieldPath {
    constructor(...segments) { this._segments = segments; }
    static documentId() { return new FieldPath('__name__'); }
    toString() { return this._segments.join('.'); }
    isEqual(o) { return o instanceof FieldPath && o.toString() === this.toString(); }
  }
  const fieldString = (f) => (f instanceof FieldPath ? f.toString() : String(f));

  function encode(value) {
    if (value === undefined) return undefined;
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value instanceof Timestamp) return { __t: 'ts', s: value.seconds, n: value.nanoseconds };
    if (value instanceof Date) { const t = Timestamp.fromDate(value); return { __t: 'ts', s: t.seconds, n: t.nanoseconds }; }
    if (value instanceof FieldValue) return { __fv: value._kind, v: value._kind.startsWith('array') ? value._value.map(encode) : value._value };
    if (value instanceof GeoPoint) return { latitude: value.latitude, longitude: value.longitude };
    if (value instanceof DocumentReference) return value.path;
    if (Array.isArray(value)) return value.map((v) => { const e = encode(v); return e === undefined ? null : e; });
    if (typeof value === 'object') {
      const out = {};
      for (const k of Object.keys(value)) { const e = encode(value[k]); if (e !== undefined) out[k] = e; }
      return out;
    }
    return null;
  }

  function decode(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(decode);
    if (value.__t === 'ts') return new Timestamp(value.s, value.n);
    const out = {};
    for (const k of Object.keys(value)) out[k] = decode(value[k]);
    return out;
  }

  const AUTO_ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  function autoId() {
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    let id = '';
    for (let i = 0; i < 20; i++) id += AUTO_ID_CHARS[bytes[i] % 62];
    return id;
  }

  const microtask = (fn) => Promise.resolve().then(fn);

  // ------------------------------------------------------------------ app
  const apps = [];
  class FirebaseApp {
    constructor(options, name) { this.options = Object.assign({}, options); this.name = name; this._services = {}; this.automaticDataCollectionEnabled = false; }
    auth() { return firebase.auth(this); }
    firestore() { return firebase.firestore(this); }
    messaging() { return firebase.messaging(this); }
    delete() { const i = apps.indexOf(this); if (i >= 0) apps.splice(i, 1); return Promise.resolve(); }
  }

  // ------------------------------------------------------------------ transport
  async function post(path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetch(API + path, { method: 'POST', headers, body: JSON.stringify(body || {}), cache: 'no-store', credentials: 'same-origin' });
    } catch (e) {
      throw new FirebaseError('unavailable', 'Failed to get document because the client is offline.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = data.error || {};
      throw new FirebaseError(err.code || 'unknown', err.message || `Request failed (${response.status}).`);
    }
    return data;
  }

  // Realtime stream (Server-Sent Events) shared by Firestore listeners and Messaging.
  const realtime = {
    source: null, cid: null, targets: new Map(), pushHandlers: new Set(), tokens: new Set(), waiting: [],
    ensure() {
      if (this.source) return;
      this.source = new EventSource(API + '/stream');
      this.source.addEventListener('hello', (e) => {
        this.cid = JSON.parse(e.data).cid;
        for (const [tid, t] of this.targets) this.sendListen(tid, t);
        for (const token of this.tokens) post('/messaging/register', { token, cid: this.cid }).catch(() => {});
        const w = this.waiting; this.waiting = []; w.forEach((fn) => fn());
      });
      this.source.addEventListener('snap', (e) => {
        const msg = JSON.parse(e.data);
        const t = this.targets.get(msg.tid);
        if (!t) return;
        if (msg.error) { this.targets.delete(msg.tid); t.onError(new FirebaseError(msg.error.code, msg.error.message)); return; }
        t.onData(msg);
      });
      this.source.addEventListener('push', (e) => {
        const msg = JSON.parse(e.data);
        this.pushHandlers.forEach((fn) => { try { fn(msg); } catch (err) { console.error(err); } });
      });
      this.source.onerror = () => { this.cid = null; };
    },
    // Like the real SDK, a credential change restarts the watch stream: every still-active listener is
    // re-sent with the new token so security rules are re-evaluated for the new user.
    async reauth() { if (!this.cid) return; for (const [tid, t] of this.targets) this.sendListen(tid, t); },
    whenConnected() { this.ensure(); return this.cid ? Promise.resolve() : new Promise((r) => this.waiting.push(r)); },
    async sendListen(tid, t) {
      if (!this.cid) return;
      const cid = this.cid;
      try {
        const token = await t.tokenProvider();
        if (!this.targets.has(tid) || cid !== this.cid) return;
        await post('/listen', { cid, tid, target: t.target }, token);
      } catch (e) {
        if (e.code === 'unavailable') return; // stream will reconnect and re-send
        if (this.targets.has(tid)) { this.targets.delete(tid); t.onError(e); }
      }
    },
    listen(target, tokenProvider, onData, onError) {
      const tid = autoId();
      const t = { target, tokenProvider, onData, onError };
      this.targets.set(tid, t);
      this.ensure();
      if (this.cid) this.sendListen(tid, t);
      return () => {
        if (!this.targets.delete(tid)) return;
        if (this.cid) post('/unlisten', { cid: this.cid, tid }).catch(() => {});
      };
    },
    relistenAll() { for (const [tid, t] of this.targets) this.sendListen(tid, t); },
    async registerToken(token) { this.tokens.add(token); await this.whenConnected(); await post('/messaging/register', { token, cid: this.cid }); },
    async unregisterToken(token) { this.tokens.delete(token); await post('/messaging/unregister', { token }); },
  };

  // ------------------------------------------------------------------ auth
  const Persistence = { LOCAL: 'local', SESSION: 'session', NONE: 'none' };

  class User {
    constructor(auth, session) {
      this._auth = auth;
      this._session = session;
      this.uid = session.uid;
      this.isAnonymous = session.provider === 'anonymous';
      this.providerId = 'firebase';
      this.providerData = [];
      this.email = null; this.displayName = null; this.photoURL = null; this.phoneNumber = null;
      this.emailVerified = false; this.tenantId = null;
      this.metadata = { creationTime: new Date(session.createdAt || Date.now()).toUTCString(), lastSignInTime: new Date().toUTCString() };
      this.refreshToken = session.refreshToken;
    }
    async getIdToken(forceRefresh) { return this._auth._freshToken(this, !!forceRefresh); }
    async getIdTokenResult(forceRefresh) {
      const token = await this.getIdToken(forceRefresh);
      const s = this._session;
      return {
        token, claims: Object.assign({ user_id: s.uid, sub: s.uid }, s.claims || {}),
        authTime: new Date(s.createdAt || Date.now()).toUTCString(), issuedAtTime: new Date(s.expiresAt - 3600000).toUTCString(),
        expirationTime: new Date(s.expiresAt).toUTCString(), signInProvider: s.provider, signInSecondFactor: null,
      };
    }
    reload() { return Promise.resolve(); }
    delete() { return this._auth.signOut(); }
    toJSON() { return { uid: this.uid, isAnonymous: this.isAnonymous, providerData: [], stsTokenManager: { expirationTime: this._session.expiresAt } }; }
  }

  class Auth {
    constructor(app) {
      this.app = app;
      this.name = app.name;
      this.config = { apiKey: app.options.apiKey };
      this.currentUser = null;
      this.languageCode = null;
      this.tenantId = null;
      this.settings = { appVerificationDisabledForTesting: false };
      this._key = `firebase:authUser:${app.options.apiKey || 'local'}:${app.name}`;
      this._persistence = Persistence.LOCAL;
      this._listeners = new Set();
      this._tokenListeners = new Set();
      this._lastNotifiedUid = undefined;
      this._ready = false;
      const saved = this._readStored();
      if (saved) this.currentUser = new User(this, saved);
      this._lastTokenKey = saved ? saved.refreshToken : null;
      // Firebase Auth resolves its initial state asynchronously.
      this._readyPromise = new Promise((r) => setTimeout(() => { this._ready = true; r(); }, 0));
      window.addEventListener('storage', (e) => {
        if (e.key !== this._key || this._persistence !== Persistence.LOCAL) return;
        const s = this._readStored();
        if ((s && s.uid) === (this.currentUser && this.currentUser.uid)) { if (s && this.currentUser) Object.assign(this.currentUser._session, s); return; }
        this.currentUser = s ? new User(this, s) : null;
        this._notify();
      });
    }
    _store() { return this._persistence === Persistence.SESSION ? window.sessionStorage : this._persistence === Persistence.LOCAL ? window.localStorage : null; }
    _readStored() {
      for (const store of [window.localStorage, window.sessionStorage]) {
        try { const raw = store.getItem(this._key); if (raw) { const s = JSON.parse(raw); if (s && s.uid && s.refreshToken) return s; } } catch (e) { /* ignore */ }
      }
      return null;
    }
    _persist() {
      // Only touch storage when the value actually changes: other tabs react to every storage event,
      // so a remove-then-set would briefly look like a sign-out to them (and they would start a new guest session).
      const store = this._store();
      for (const other of [window.localStorage, window.sessionStorage]) {
        if (other === store) continue;
        try { if (other.getItem(this._key) !== null) other.removeItem(this._key); } catch (e) { /* ignore */ }
      }
      if (!store) return;
      try {
        if (this.currentUser) { const value = JSON.stringify(this.currentUser._session); if (store.getItem(this._key) !== value) store.setItem(this._key, value); }
        else if (store.getItem(this._key) !== null) store.removeItem(this._key);
      } catch (e) { /* ignore */ }
    }
    _notify(force) {
      const uid = this.currentUser ? this.currentUser.uid : null;
      const tokenKey = this.currentUser ? this.currentUser._session.refreshToken : null;
      if (tokenKey !== this._lastTokenKey) { this._lastTokenKey = tokenKey; realtime.reauth(); }
      this._tokenListeners.forEach((fn) => microtask(() => fn(this.currentUser)));
      if (!force && uid === this._lastNotifiedUid) return;
      this._lastNotifiedUid = uid;
      this._listeners.forEach((l) => microtask(() => l.next && l.next(this.currentUser)));
    }
    async _freshToken(user, force) {
      const s = user._session;
      if (!force && s.idToken && Date.now() < s.expiresAt - 60000) return s.idToken;
      const fresh = await post('/auth/refresh', { refreshToken: s.refreshToken }).catch((e) => { throw new FirebaseError(e.code && e.code.startsWith('auth/') ? e.code : 'auth/network-request-failed', e.message); });
      Object.assign(s, fresh);
      if (this.currentUser === user) this._persist();
      return s.idToken;
    }
    async _token() { return this.currentUser ? this._freshToken(this.currentUser, false).catch(() => null) : null; }
    setPersistence(p) {
      if (!Object.values(Persistence).includes(p)) return Promise.reject(new FirebaseError('auth/invalid-persistence-type', 'The specified persistence type is invalid.'));
      this._persistence = p;
      this._persist();
      return Promise.resolve();
    }
    onAuthStateChanged(nextOrObserver, error, completed) {
      const l = typeof nextOrObserver === 'function' ? { next: nextOrObserver, error, complete: completed } : nextOrObserver || {};
      this._listeners.add(l);
      this._readyPromise.then(() => { if (this._listeners.has(l) && l.next) { this._lastNotifiedUid = this.currentUser ? this.currentUser.uid : null; l.next(this.currentUser); } });
      return () => this._listeners.delete(l);
    }
    onIdTokenChanged(next) {
      const fn = typeof next === 'function' ? next : (next && next.next) || (() => {});
      this._tokenListeners.add(fn);
      this._readyPromise.then(() => fn(this.currentUser));
      return () => this._tokenListeners.delete(fn);
    }
    async _signIn(session) {
      session.createdAt = session.createdAt || Date.now();
      this.currentUser = new User(this, session);
      this._persist();
      this._notify();
      return { user: this.currentUser, credential: null, operationType: 'signIn', additionalUserInfo: { isNewUser: session.provider === 'anonymous', providerId: session.provider === 'anonymous' ? null : 'custom', profile: {} } };
    }
    async signInAnonymously() {
      await this._readyPromise;
      if (this.currentUser && this.currentUser.isAnonymous) return { user: this.currentUser, credential: null, operationType: 'signIn', additionalUserInfo: { isNewUser: false, providerId: null, profile: {} } };
      const session = await post('/auth/anonymous', {}).catch((e) => { throw new FirebaseError('auth/network-request-failed', e.message); });
      return this._signIn(session);
    }
    async signInWithCustomToken(customToken) {
      await this._readyPromise;
      const session = await post('/auth/custom', { customToken }).catch((e) => { throw new FirebaseError(e.code && String(e.code).startsWith('auth/') ? e.code : 'auth/invalid-custom-token', e.message); });
      return this._signIn(session);
    }
    async signOut() {
      await this._readyPromise;
      this.currentUser = null;
      this._persist();
      this._notify();
    }
    useDeviceLanguage() {}
    useEmulator() {}
  }

  // ------------------------------------------------------------------ firestore
  const splitPath = (p) => String(p || '').split('/').filter(Boolean);

  class SnapshotMetadata {
    constructor() { this.hasPendingWrites = false; this.fromCache = false; }
    isEqual(o) { return !!o && o.hasPendingWrites === this.hasPendingWrites && o.fromCache === this.fromCache; }
  }

  class DocumentSnapshot {
    constructor(firestore, path, raw) {
      this._firestore = firestore;
      this.ref = new DocumentReference(firestore, path);
      this.id = this.ref.id;
      this._data = raw && raw.data ? raw.data : null;
      this.exists = !!this._data;
      this.metadata = new SnapshotMetadata();
      this._updateTime = raw && raw.updateTime ? raw.updateTime : null;
    }
    data() { return this._data ? decode(JSON.parse(JSON.stringify(this._data))) : undefined; }
    get(field) {
      if (!this._data) return undefined;
      let cur = this._data;
      for (const part of fieldString(field).split('.')) { if (!cur || typeof cur !== 'object' || !(part in cur)) return undefined; cur = cur[part]; }
      return decode(JSON.parse(JSON.stringify(cur)));
    }
    isEqual(o) { return o instanceof DocumentSnapshot && o.ref.path === this.ref.path && JSON.stringify(o._data) === JSON.stringify(this._data); }
  }
  class QueryDocumentSnapshot extends DocumentSnapshot {
    data() { return super.data(); }
  }

  class QuerySnapshot {
    constructor(query, docs, previous) {
      this.query = query;
      this.docs = docs;
      this.size = docs.length;
      this.empty = docs.length === 0;
      this.metadata = new SnapshotMetadata();
      this._previous = previous || null;
    }
    forEach(cb, thisArg) { this.docs.forEach((d) => cb.call(thisArg, d)); }
    docChanges() {
      const prev = this._previous ? this._previous.docs : [];
      const changes = [];
      const prevIndex = new Map(prev.map((d, i) => [d.ref.path, i]));
      const nextIndex = new Map(this.docs.map((d, i) => [d.ref.path, i]));
      prev.forEach((d, i) => { if (!nextIndex.has(d.ref.path)) changes.push({ type: 'removed', doc: d, oldIndex: i, newIndex: -1 }); });
      this.docs.forEach((d, i) => {
        if (!prevIndex.has(d.ref.path)) changes.push({ type: 'added', doc: d, oldIndex: -1, newIndex: i });
        else {
          const old = prev[prevIndex.get(d.ref.path)];
          if (JSON.stringify(old._data) !== JSON.stringify(d._data) || prevIndex.get(d.ref.path) !== i) changes.push({ type: 'modified', doc: d, oldIndex: prevIndex.get(d.ref.path), newIndex: i });
        }
      });
      return changes;
    }
    isEqual(o) { return o instanceof QuerySnapshot && o.docs.length === this.docs.length && o.docs.every((d, i) => d.isEqual(this.docs[i])); }
  }

  function parseSnapshotArgs(args) {
    let i = 0;
    if (args[0] && typeof args[0] === 'object' && !('next' in args[0]) && !('error' in args[0]) && typeof args[0] !== 'function') i = 1; // options
    const a = args[i];
    if (typeof a === 'function') return { next: a, error: args[i + 1], complete: args[i + 2] };
    return { next: a && a.next ? a.next.bind(a) : () => {}, error: a && a.error ? a.error.bind(a) : undefined, complete: a && a.complete };
  }
  function reportListenError(error, observer) {
    if (observer.error) observer.error(error);
    else console.error('Uncaught Error in snapshot listener:', error);
  }

  class Query {
    constructor(firestore, path, spec) {
      this.firestore = firestore;
      this._path = splitPath(path).join('/');
      this._spec = Object.assign({ where: [], orderBy: [], limit: null, limitToLast: null }, spec || {});
    }
    _with(change) { return new Query(this.firestore, this._path, Object.assign({}, this._spec, change)); }
    where(field, op, value) { return this._with({ where: this._spec.where.concat([[fieldString(field), op, encode(value)]]) }); }
    orderBy(field, dir) { return this._with({ orderBy: this._spec.orderBy.concat([[fieldString(field), dir === 'desc' ? 'desc' : 'asc']]) }); }
    limit(n) { return this._with({ limit: n, limitToLast: null }); }
    limitToLast(n) { return this._with({ limitToLast: n, limit: null }); }
    _query() { return { path: this._path, where: this._spec.where, orderBy: this._spec.orderBy, limit: this._spec.limit, limitToLast: this._spec.limitToLast }; }
    _snapshot(docs, previous) { return new QuerySnapshot(this, docs.map((d) => new QueryDocumentSnapshot(this.firestore, d.path, d)), previous); }
    async get() {
      const token = await this.firestore._token();
      const res = await post('/query', { query: this._query() }, token);
      return this._snapshot(res.docs || []);
    }
    onSnapshot(...args) {
      const observer = parseSnapshotArgs(args);
      let last = null;
      return realtime.listen({ kind: 'query', query: this._query() }, () => this.firestore._token(),
        (msg) => { const snap = this._snapshot(msg.docs || [], last); last = snap; observer.next(snap); },
        (err) => reportListenError(err, observer));
    }
    isEqual(o) { return o instanceof Query && o._path === this._path && JSON.stringify(o._spec) === JSON.stringify(this._spec); }
    startAt() { throw new FirebaseError('unimplemented', 'startAt is not supported by the local Hero backend.'); }
    startAfter() { throw new FirebaseError('unimplemented', 'startAfter is not supported by the local Hero backend.'); }
    endAt() { throw new FirebaseError('unimplemented', 'endAt is not supported by the local Hero backend.'); }
    endBefore() { throw new FirebaseError('unimplemented', 'endBefore is not supported by the local Hero backend.'); }
  }

  class CollectionReference extends Query {
    constructor(firestore, path) {
      super(firestore, path);
      const parts = splitPath(path);
      if (parts.length % 2 !== 1) throw new FirebaseError('invalid-argument', `Invalid collection reference. Collection references must have an odd number of segments, but ${parts.join('/')} has ${parts.length}.`);
      this.id = parts[parts.length - 1];
      this.path = parts.join('/');
    }
    get parent() { const parts = splitPath(this.path); return parts.length > 1 ? new DocumentReference(this.firestore, parts.slice(0, -1).join('/')) : null; }
    doc(id) { return new DocumentReference(this.firestore, `${this.path}/${id === undefined ? autoId() : id}`); }
    async add(data) { const ref = this.doc(); await ref.set(data); return ref; }
    isEqual(o) { return o instanceof CollectionReference && o.path === this.path; }
  }

  function normalizeUpdateArgs(args) {
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && !(args[0] instanceof FieldPath)) {
      const out = {};
      for (const k of Object.keys(args[0])) out[k] = args[0][k];
      return out;
    }
    const out = {};
    for (let i = 0; i < args.length; i += 2) out[fieldString(args[i])] = args[i + 1];
    return out;
  }

  class DocumentReference {
    constructor(firestore, path) {
      const parts = splitPath(path);
      if (parts.length % 2 !== 0 || !parts.length) throw new FirebaseError('invalid-argument', `Invalid document reference. Document references must have an even number of segments, but ${parts.join('/')} has ${parts.length}.`);
      this.firestore = firestore;
      this.path = parts.join('/');
      this.id = parts[parts.length - 1];
    }
    get parent() { return new CollectionReference(this.firestore, splitPath(this.path).slice(0, -1).join('/')); }
    collection(path) { return new CollectionReference(this.firestore, `${this.path}/${path}`); }
    async get() {
      const token = await this.firestore._token();
      const res = await post('/get', { path: this.path }, token);
      return new DocumentSnapshot(this.firestore, this.path, res);
    }
    set(data, options) { return this.firestore._commit([{ type: 'set', path: this.path, data: encode(data || {}), merge: !!(options && (options.merge || options.mergeFields)) }]); }
    update(...args) { return this.firestore._commit([{ type: 'update', path: this.path, data: encode(normalizeUpdateArgs(args)) }]); }
    delete() { return this.firestore._commit([{ type: 'delete', path: this.path }]); }
    onSnapshot(...args) {
      const observer = parseSnapshotArgs(args);
      return realtime.listen({ kind: 'doc', path: this.path }, () => this.firestore._token(),
        (msg) => observer.next(new DocumentSnapshot(this.firestore, this.path, msg.doc)),
        (err) => reportListenError(err, observer));
    }
    isEqual(o) { return o instanceof DocumentReference && o.path === this.path; }
  }

  class WriteBatch {
    constructor(firestore) { this._firestore = firestore; this._writes = []; this._committed = false; }
    _ref(ref) { if (!(ref instanceof DocumentReference)) throw new FirebaseError('invalid-argument', 'Expected a DocumentReference.'); return ref; }
    set(ref, data, options) { this._writes.push({ type: 'set', path: this._ref(ref).path, data: encode(data || {}), merge: !!(options && (options.merge || options.mergeFields)) }); return this; }
    update(ref, ...args) { this._writes.push({ type: 'update', path: this._ref(ref).path, data: encode(normalizeUpdateArgs(args)) }); return this; }
    delete(ref) { this._writes.push({ type: 'delete', path: this._ref(ref).path }); return this; }
    commit() {
      if (this._committed) return Promise.reject(new FirebaseError('failed-precondition', 'A write batch can no longer be used after commit() has been called.'));
      this._committed = true;
      return this._writes.length ? this._firestore._commit(this._writes) : Promise.resolve();
    }
  }

  class Transaction {
    constructor(firestore) { this._firestore = firestore; this._writes = []; this._reads = new Map(); }
    async get(ref) {
      if (this._writes.length) throw new FirebaseError('invalid-argument', 'Firestore transactions require all reads to be executed before all writes.');
      const token = await this._firestore._token();
      const res = await post('/get', { path: ref.path }, token);
      this._reads.set(ref.path, res.updateTime || null);
      return new DocumentSnapshot(this._firestore, ref.path, res);
    }
    set(ref, data, options) { this._writes.push({ type: 'set', path: ref.path, data: encode(data || {}), merge: !!(options && options.merge) }); return this; }
    update(ref, ...args) { this._writes.push({ type: 'update', path: ref.path, data: encode(normalizeUpdateArgs(args)) }); return this; }
    delete(ref) { this._writes.push({ type: 'delete', path: ref.path }); return this; }
  }

  class Firestore {
    constructor(app) { this.app = app; this._settings = {}; }
    _auth() { return firebase.auth(this.app); }
    _token() { return this._auth()._token(); }
    async _commit(writes, preconditions) {
      const token = await this._token();
      await post('/commit', { writes, preconditions: preconditions || [] }, token);
    }
    collection(path) { return new CollectionReference(this, path); }
    doc(path) { return new DocumentReference(this, path); }
    collectionGroup() { throw new FirebaseError('unimplemented', 'collectionGroup is not supported by the local Hero backend.'); }
    batch() { return new WriteBatch(this); }
    async runTransaction(updateFunction, options) {
      const attempts = (options && options.maxAttempts) || 5;
      let lastError;
      for (let i = 0; i < attempts; i++) {
        const tx = new Transaction(this);
        const result = await updateFunction(tx);
        try {
          const preconditions = [...tx._reads].map(([path, updateTime]) => ({ path, updateTime }));
          if (tx._writes.length) await this._commit(tx._writes, preconditions);
          return result;
        } catch (e) {
          lastError = e;
          if (e.code !== 'aborted') throw e;
          await new Promise((r) => setTimeout(r, 50 * (i + 1) + Math.random() * 50));
        }
      }
      throw lastError || new FirebaseError('aborted', 'Transaction failed after too many attempts.');
    }
    settings(s) { Object.assign(this._settings, s || {}); }
    enablePersistence() { return Promise.resolve(); }
    clearPersistence() { return Promise.resolve(); }
    enableNetwork() { return Promise.resolve(); }
    disableNetwork() { return Promise.resolve(); }
    waitForPendingWrites() { return Promise.resolve(); }
    terminate() { return Promise.resolve(); }
    useEmulator() {}
  }

  // ------------------------------------------------------------------ messaging
  const TOKEN_KEY = 'hero-local-messaging-token';
  class Messaging {
    constructor(app) { this.app = app; this._handlers = new Set(); this._registration = null; this._token = null; }
    async getToken(options) {
      options = options || {};
      if (!('Notification' in window)) throw new FirebaseError('messaging/unsupported-browser', 'This browser doesn\'t support the API\'s required to use the Firebase SDK.');
      if (Notification.permission === 'default') await Notification.requestPermission();
      if (Notification.permission !== 'granted') throw new FirebaseError('messaging/permission-blocked', 'The notification permission was not granted and blocked instead.');
      this._registration = options.serviceWorkerRegistration || this._registration || (await navigator.serviceWorker.register('/firebase-messaging-sw.js'));
      let token = localStorage.getItem(TOKEN_KEY);
      if (!token) {
        const bytes = new Uint8Array(120);
        crypto.getRandomValues(bytes);
        token = 'hero-local:' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        localStorage.setItem(TOKEN_KEY, token);
      }
      this._token = token;
      await realtime.registerToken(token);
      return token;
    }
    async deleteToken() {
      const token = localStorage.getItem(TOKEN_KEY);
      if (token) { localStorage.removeItem(TOKEN_KEY); await realtime.unregisterToken(token).catch(() => {}); }
      this._token = null;
      return true;
    }
    onMessage(nextOrObserver) {
      const fn = typeof nextOrObserver === 'function' ? nextOrObserver : nextOrObserver && nextOrObserver.next && nextOrObserver.next.bind(nextOrObserver);
      if (fn) this._handlers.add(fn);
      return () => this._handlers.delete(fn);
    }
    _deliver(msg) {
      if (!this._token || msg.token !== this._token) return;
      const payload = { data: msg.data || {}, notification: msg.notification || undefined, from: String(this.app.options.messagingSenderId || ''), messageId: autoId(), collapseKey: 'hero-announcement' };
      if (document.visibilityState === 'visible' && this._handlers.size) {
        this._handlers.forEach((fn) => fn(payload));
        return;
      }
      // Background delivery: mirror firebase-messaging-sw.js onBackgroundMessage.
      const data = payload.data;
      const show = (reg) => reg && reg.showNotification(data.title || 'Hero update', {
        body: data.body || 'There is a new announcement in Hero.',
        icon: '/hero-push-icon.svg', badge: '/hero-push-icon.svg', data: { url: data.url || '/' }, tag: 'hero-announcement',
      });
      Promise.resolve(this._registration || navigator.serviceWorker.getRegistration('/')).then(show).catch((e) => console.warn('Could not show notification:', e));
    }
  }

  // ------------------------------------------------------------------ namespace
  function getApp(app) {
    if (app) return app;
    const def = apps.find((a) => a.name === '[DEFAULT]');
    if (!def) throw new FirebaseError('app/no-app', "Firebase: No Firebase App '[DEFAULT]' has been created - call Firebase App.initializeApp() (app/no-app).");
    return def;
  }
  function service(app, key, Ctor) {
    app = getApp(app);
    if (!app._services[key]) app._services[key] = new Ctor(app);
    return app._services[key];
  }

  const firebase = {
    SDK_VERSION,
    apps,
    initializeApp(options, name) {
      name = typeof name === 'string' ? name : (name && name.name) || '[DEFAULT]';
      if (apps.some((a) => a.name === name)) throw new FirebaseError('app/duplicate-app', `Firebase: Firebase App named '${name}' already exists with different options or config (app/duplicate-app).`);
      const app = new FirebaseApp(options || {}, name);
      apps.push(app);
      return app;
    },
    app(name) {
      const a = apps.find((x) => x.name === (name || '[DEFAULT]'));
      if (!a) throw new FirebaseError('app/no-app', `Firebase: No Firebase App '${name || '[DEFAULT]'}' has been created - call Firebase App.initializeApp() (app/no-app).`);
      return a;
    },
    auth(app) {
      const auth = service(app, 'auth', Auth);
      if (!auth._wired) {
        auth._wired = true;
        // Firestore re-authenticates active listeners whenever the signed-in user changes.
        let lastUid;
        auth.onIdTokenChanged((user) => { const uid = user ? user.uid : null; if (lastUid !== undefined && uid !== lastUid) realtime.relistenAll(); lastUid = uid; });
      }
      return auth;
    },
    firestore(app) { return service(app, 'firestore', Firestore); },
    messaging(app) {
      const m = service(app, 'messaging', Messaging);
      if (!m._wired) { m._wired = true; realtime.pushHandlers.add((msg) => m._deliver(msg)); }
      return m;
    },
    FirebaseError,
  };
  firebase.auth.Auth = { Persistence };
  firebase.auth.FirebaseError = FirebaseError;
  firebase.firestore.Timestamp = Timestamp;
  firebase.firestore.FieldValue = FieldValue;
  firebase.firestore.FieldPath = FieldPath;
  firebase.firestore.GeoPoint = GeoPoint;
  firebase.firestore.Firestore = Firestore;
  firebase.firestore.setLogLevel = () => {};
  firebase.messaging.isSupported = async () => 'serviceWorker' in navigator && 'Notification' in window && 'PushManager' in window && typeof EventSource !== 'undefined';
  firebase.registerVersion = () => {};
  firebase.onLog = () => {};
  firebase.setLogLevel = () => {};

  window.firebase = firebase;
})();
