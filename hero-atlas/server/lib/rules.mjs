// A faithful JavaScript port of ../../firestore.rules, evaluated by the local datastore.
// op: 'get' | 'list' | 'create' | 'update' | 'delete'
// For 'list', resource is unknown: rules that depend on resource.data deny non-steward listing,
// matching Firestore's requirement that such queries be constrained (Hero never adds those filters).
import { isMap, isTimestamp, affectedKeys } from './values.mjs';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string';
const keys = (d) => Object.keys(d || {});
const hasOnly = (d, allowed) => keys(d).every((k) => allowed.includes(k));
const hasAll = (d, required) => required.every((k) => k in (d || {}));
const DAY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const fullMatch = (re, s) => isStr(s) && new RegExp(`^(?:${re})$`).test(s);

const GUEST_BOARDS = ['guestLeaderboardOneYear', 'guestLeaderboardTwoYear'];
const ALL_BOARDS = ['leaderboard', 'leaderboardTwoYear', ...GUEST_BOARDS];

export function allowed({ op, segments, auth, resource, request }) {
  const admin = !!(auth && auth.admin === true);
  const guest = !!(auth && auth.provider === 'anonymous');
  const signedIn = admin || guest;
  const uid = auth ? auth.uid : null;
  const read = op === 'get' || op === 'list';
  const write = op === 'create' || op === 'update' || op === 'delete';
  const listing = op === 'list';
  const res = resource || null; // existing data (null on create / list)
  const req = request || null; // resulting data (create/update)
  const resUserIs = (u) => !listing && res && res.userId === u;

  // /artifacts/{appId}/public/data/...
  if (segments.length < 6 || segments[0] !== 'artifacts' || segments[2] !== 'public' || segments[3] !== 'data') return false;
  const rest = segments.slice(4);

  // ---- two-segment paths: /{collection}/{doc}
  if (rest.length === 2) {
    const [col, id] = rest;

    if (col === 'globalSettings') {
      let ok = false;
      if (read && signedIn) ok = true;
      if (write && admin) ok = true;
      if (id === 'stats') {
        if (op === 'create' && (admin || (signedIn && hasOnly(req, ['visits']) && req.visits === 1))) ok = true;
        if (op === 'update' && (admin || (signedIn && hasOnly(req, ['visits']) && res && req.visits === (res.visits || 0) + 1))) ok = true;
      }
      return ok;
    }

    if (col === 'members') return admin;
    if (col === 'deviceProfiles') return admin;
    if (col === 'accountRecovery') return false;
    if (col === 'flappy') return admin;

    if (col === 'dailyChallengeProgress') {
      if (op === 'get') return admin || (signedIn && uid === id);
      if (op === 'list') return admin;
      if (op === 'delete') return admin || (signedIn && uid === id);
      const f = ['userId', 'currentStreak', 'longestStreak', 'lastCompletedDay', 'updatedAt'];
      return signedIn && uid === id && hasOnly(req, f) && hasAll(req, f) && req.userId === uid
        && isNum(req.currentStreak) && req.currentStreak >= 1 && req.currentStreak <= 10000
        && isNum(req.longestStreak) && req.longestStreak >= req.currentStreak && req.longestStreak <= 10000
        && isStr(req.lastCompletedDay) && DAY_RE.test(req.lastCompletedDay);
    }

    if (col === 'memberStats') {
      const owns = signedIn && uid === id;
      if (op === 'get') return admin || owns;
      if (op === 'list') return admin;
      if (op === 'delete') return admin || owns;
      const f = ['userId', 'missesOneYear', 'missesTwoYear', 'updatedAt'];
      const validMisses = (k) => isMap(req[k]) && keys(req[k]).length <= 1000;
      return owns && hasOnly(req, f) && hasAll(req, f) && req.userId === uid
        && validMisses('missesOneYear') && validMisses('missesTwoYear') && isTimestamp(req.updatedAt);
    }

    if (col === 'presence') {
      const f = ['userId', 'deviceId', 'lastSeen', 'device', 'os', 'browser', 'view', 'mode', 'theme', 'vw', 'vh'];
      const idOk = fullMatch('.*__[A-Za-z0-9]{20}', id);
      if (op === 'create') return signedIn && req.userId === uid && idOk && hasOnly(req, f);
      if (op === 'update') return signedIn && res && res.userId === uid && req.userId === uid && idOk && hasOnly(req, f);
      if (read) return admin || (signedIn && resUserIs(uid));
      if (op === 'delete') return admin || (signedIn && (id === uid || resUserIs(uid)));
      return false;
    }

    if (col === 'runtimeBugs') {
      if (op === 'create') {
        const f = ['type', 'message', 'stack', 'source', 'line', 'column', 'fingerprint', 'page', 'userId', 'deviceId', 'appVersion', 'status', 'createdAt'];
        return signedIn && hasOnly(req, f) && req.userId === uid && fullMatch('d_[A-Za-z0-9-]{12}', req.deviceId)
          && ['exception', 'rejection'].includes(req.type)
          && isStr(req.message) && req.message.length <= 500 && isStr(req.stack) && req.stack.length <= 1800
          && isStr(req.source) && req.source.length <= 300 && isStr(req.page) && req.page.length <= 200
          && isStr(req.appVersion) && req.appVersion.length <= 30 && req.status === 'new';
      }
      if (read || op === 'delete') return admin || (signedIn && resUserIs(uid));
      if (op === 'update') return admin && hasOnly(Object.fromEntries(affectedKeys(res, req).map((k) => [k, 1])), ['status', 'resolvedAt']) && ['new', 'resolved'].includes(req.status);
      return false;
    }

    if (col === 'analytics') {
      if (op === 'create' || op === 'update') {
        return signedIn && hasOnly(req, ['day', 'sessions', 'started', 'completed', 'quit', 'm_default', 'm_twoyear',
          'd_mobile', 'd_tablet', 'd_desktop', 'o_ios', 'o_android', 'o_windows', 'o_mac', 'o_linux', 'o_chromeos', 'o_other',
          'b_chrome', 'b_safari', 'b_firefox', 'b_edge', 'b_opera', 'b_samsung', 'b_other']);
      }
      if (read) return admin;
      return false;
    }

    if (col === 'bans') {
      if (op === 'get') return signedIn;
      return admin; // list, write
    }

    if (col === 'guestFlappy') {
      if (read) return signedIn;
      const f = ['score', 'userId', 'ts'];
      if (op === 'create') return signedIn && id === uid && hasOnly(req, f) && req.userId === uid && isNum(req.score) && req.score >= 1 && req.score <= 500;
      if (op === 'update') return signedIn && id === uid && hasOnly(req, f) && res && req.userId === res.userId && req.userId === uid && isNum(req.score) && req.score >= res.score && req.score <= 500;
      if (op === 'delete') return admin || (signedIn && resUserIs(uid));
      return false;
    }

    if (col === 'announcements') return read ? signedIn : admin;

    if (col === 'feedback') {
      if (op === 'create') {
        const f = ['id', 'type', 'typeLabel', 'area', 'title', 'description', 'userId', 'status', 'mode', 'attachments', 'createdAt', 'appVersion', 'contact', 'severity', 'frequency', 'steps', 'diagnostics'];
        return signedIn && hasOnly(req, f) && hasAll(req, ['id', 'type', 'title', 'description', 'userId', 'status', 'createdAt'])
          && req.userId === uid && req.status === 'new' && isStr(req.title) && req.title.length <= 120
          && isStr(req.description) && req.description.length <= 2000 && Array.isArray(req.attachments || []) && (req.attachments || []).length <= 5;
      }
      if (read || op === 'delete') return admin || (signedIn && resUserIs(uid));
      if (op === 'update') return admin && affectedKeys(res, req).every((k) => k === 'status');
      return false;
    }

    // match /{board}/{entryId}
    if (op === 'get' || op === 'list') return (admin && ALL_BOARDS.includes(col)) || (signedIn && GUEST_BOARDS.includes(col));
    if (op === 'create' || op === 'update') {
      if (!(signedIn && GUEST_BOARDS.includes(col) && id === uid)) return false;
      const f = ['userId', 'score', 'time', 'timestamp', 'tour', 'perfect'];
      const base = hasOnly(req, f) && req.userId === uid && isNum(req.score) && req.score >= 0 && req.score <= 1000000
        && isNum(req.time) && req.time >= 0 && (!('tour' in req) || ['1 Year', '2 Year'].includes(req.tour))
        && (!('perfect' in req) || typeof req.perfect === 'boolean');
      if (op === 'create') return base;
      return base && res && req.userId === res.userId && (req.score > res.score || (req.score === res.score && req.time < res.time));
    }
    if (op === 'delete') return (admin && ALL_BOARDS.includes(col)) || (signedIn && GUEST_BOARDS.includes(col) && resUserIs(uid));
    return false;
  }

  // ---- four-segment paths: /{collection}/{doc}/{sub}/{subDoc}
  if (rest.length === 4) {
    const [col, id, sub, subId] = rest;

    if (col === 'dailyChallenges' && sub === 'scores') return admin;
    if (col === 'dailyChallenges' && sub === 'guestScores') {
      const day = id;
      if (read) return signedIn;
      if (op === 'delete') return admin || (signedIn && resUserIs(uid));
      const f = ['userId', 'score', 'time', 'day', 'hints', 'locations', 'solved', 'timestamp'];
      const base = signedIn && DAY_RE.test(day) && subId === uid && hasOnly(req, f) && hasAll(req, f)
        && isNum(req.score) && req.score >= 0 && req.score <= 1000000 && isNum(req.time) && req.time >= 0
        && isNum(req.hints) && req.hints >= 0 && req.hints <= 20
        && isNum(req.locations) && req.locations >= 5 && req.locations <= 10 && req.solved === req.locations;
      if (op === 'create') return base && req.userId === uid && req.day === day;
      return base && res && req.userId === res.userId && req.day === res.day
        && (req.score > res.score || (req.score === res.score && req.time < res.time));
    }

    if (col === 'members' && sub === 'pushTokens') {
      if (read) return admin || (signedIn && uid === id);
      if (op === 'delete') return admin || (signedIn && uid === id);
      const f = ['token', 'enabled', 'updatedAt'];
      return signedIn && uid === id && hasOnly(req, f) && hasAll(req, f) && isStr(req.token)
        && req.token.length >= 100 && req.token.length <= 4096 && req.enabled === true && isTimestamp(req.updatedAt);
    }

    if (col === 'feedback' && sub === 'files') {
      if (op === 'create') {
        return signedIn && hasOnly(req, ['userId', 'name', 'type', 'index', 'total', 'data']) && req.userId === uid
          && isStr(req.data) && req.data.length <= 760000 && isStr(req.type) && (/^image\/.*$/.test(req.type) || /^video\/.*$/.test(req.type));
      }
      if (read || op === 'delete') return admin || (signedIn && resUserIs(uid));
      return false;
    }
    // The legacy /{board}/{entryId} match does not cover deeper paths.
    return false;
  }

  return false;
}
