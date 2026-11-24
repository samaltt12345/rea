// Delivers emulated FCM messages to browsers over the realtime stream.
// A messaging token is registered by the page that requested it; messages to tokens whose page is
// closed are queued (TTL 24h, like the original webpush TTL header) and delivered when it reconnects.
const TTL_MS = 24 * 60 * 60 * 1000;

export class PushHub {
  constructor() {
    this.tokens = new Map(); // token -> Set(cid)
    this.known = new Set(); // tokens ever registered (and not deleted)
    this.queue = new Map(); // token -> [{ data, notification, at }]
    this.sendToConnection = () => false;
  }

  register(token, cid) {
    if (!token) return;
    this.known.add(token);
    if (!this.tokens.has(token)) this.tokens.set(token, new Set());
    this.tokens.get(token).add(cid);
    const pending = (this.queue.get(token) || []).filter((m) => Date.now() - m.at < TTL_MS);
    this.queue.delete(token);
    for (const m of pending) this.sendToConnection(cid, { token, data: m.data, notification: m.notification });
  }

  unregister(token) {
    this.tokens.delete(token);
    this.known.delete(token);
    this.queue.delete(token);
  }

  dropConnection(cid) {
    for (const set of this.tokens.values()) set.delete(cid);
  }

  send(token, data, notification) {
    if (!token || !this.known.has(token)) return false;
    const cids = [...(this.tokens.get(token) || [])];
    let delivered = false;
    for (const cid of cids) delivered = this.sendToConnection(cid, { token, data, notification }) || delivered;
    if (!delivered) {
      const q = this.queue.get(token) || [];
      q.push({ data, notification, at: Date.now() });
      this.queue.set(token, q.slice(-20));
    }
    return true;
  }
}
