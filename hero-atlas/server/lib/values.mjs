// Wire/storage encoding shared with server/client/firebase-local.js.
//   Timestamp           -> { "__t": "ts", "s": seconds, "n": nanoseconds }
//   FieldValue sentinel -> { "__fv": "serverTimestamp" | "increment" | "delete" | "arrayUnion" | "arrayRemove", "v": ... }
// Everything else is plain JSON.

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isTimestamp = (v) => isPlainObject(v) && v.__t === 'ts';
export const isSentinel = (v) => isPlainObject(v) && typeof v.__fv === 'string';
export const isMap = (v) => isPlainObject(v) && !isTimestamp(v) && !isSentinel(v);

export function timestampFromMillis(ms) {
  const s = Math.floor(ms / 1000);
  return { __t: 'ts', s, n: Math.round((ms - s * 1000) * 1e6) };
}
export const tsMillis = (t) => t.s * 1000 + Math.floor(t.n / 1e6);

export const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// Firestore type order: null < bool < number < timestamp < string < bytes < ref < geo < array < map
function typeRank(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return 1;
  if (typeof v === 'number') return 2;
  if (isTimestamp(v)) return 3;
  if (typeof v === 'string') return 4;
  if (Array.isArray(v)) return 8;
  return 9;
}

export function compareValues(a, b) {
  const ra = typeRank(a), rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  switch (ra) {
    case 0: return 0;
    case 1: return (a ? 1 : 0) - (b ? 1 : 0);
    case 2: return a === b ? 0 : (a < b ? -1 : 1);
    case 3: return a.s !== b.s ? a.s - b.s : a.n - b.n;
    case 4: return a === b ? 0 : (a < b ? -1 : 1);
    case 8: {
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const c = compareValues(a[i], b[i]);
        if (c) return c;
      }
      return a.length - b.length;
    }
    default: {
      const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
      for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
        if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
        const c = compareValues(a[ka[i]], b[kb[i]]);
        if (c) return c;
      }
      return ka.length - kb.length;
    }
  }
}
export const valuesEqual = (a, b) => typeRank(a) === typeRank(b) && compareValues(a, b) === 0;

export function getField(data, fieldPath) {
  if (fieldPath === '__name__') return undefined;
  let cur = data;
  for (const part of String(fieldPath).split('.')) {
    if (!isMap(cur) || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

// Apply FieldValue sentinels found in `incoming` while merging into `base`.
function resolveSentinel(sentinel, previous, now) {
  switch (sentinel.__fv) {
    case 'serverTimestamp': return clone(now);
    case 'increment': {
      const by = Number(sentinel.v) || 0;
      return (typeof previous === 'number' ? previous : 0) + by;
    }
    case 'arrayUnion': {
      const out = Array.isArray(previous) ? previous.slice() : [];
      for (const item of sentinel.v || []) if (!out.some((x) => valuesEqual(x, item))) out.push(item);
      return out;
    }
    case 'arrayRemove': {
      const out = Array.isArray(previous) ? previous.slice() : [];
      return out.filter((x) => !(sentinel.v || []).some((item) => valuesEqual(x, item)));
    }
    default: return undefined;
  }
}

// Resolve sentinels in a value that is being written wholesale (set without merge / nested new maps).
export function resolveValue(value, previous, now) {
  if (isSentinel(value)) return value.__fv === 'delete' ? undefined : resolveSentinel(value, previous, now);
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, undefined, now));
  if (isMap(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const r = resolveValue(v, isMap(previous) ? previous[k] : undefined, now);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return value;
}

// Deep merge (set with { merge: true }).
export function mergeInto(base, incoming, now) {
  const out = isMap(base) ? clone(base) : {};
  for (const [k, v] of Object.entries(incoming || {})) {
    if (isSentinel(v)) {
      if (v.__fv === 'delete') delete out[k];
      else out[k] = resolveSentinel(v, out[k], now);
    } else if (isMap(v)) {
      out[k] = mergeInto(isMap(out[k]) ? out[k] : {}, v, now);
    } else {
      out[k] = resolveValue(v, out[k], now);
    }
  }
  return out;
}

// update(): keys may be dotted field paths; nested maps given as values replace the field entirely.
export function applyUpdate(base, updates, now) {
  const out = clone(base) || {};
  for (const [path, v] of Object.entries(updates || {})) {
    const parts = path.split('.');
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!isMap(cur[parts[i]])) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    const last = parts[parts.length - 1];
    if (isSentinel(v) && v.__fv === 'delete') delete cur[last];
    else if (isSentinel(v)) cur[last] = resolveSentinel(v, cur[last], now);
    else cur[last] = resolveValue(v, cur[last], now);
  }
  return out;
}

// Keys whose values differ between two maps (top level), used by rules' diff().affectedKeys().
export function affectedKeys(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((k) => !valuesEqual((before || {})[k], (after || {})[k]) || ((k in (before || {})) !== (k in (after || {}))));
}
