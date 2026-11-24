// Local stand-in for Firebase Auth tokens: compact HMAC-signed JSON tokens.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export class TokenSigner {
  constructor(secret) { this.secret = secret; }

  sign(payload) {
    const body = b64u(JSON.stringify(payload));
    const sig = createHmac('sha256', this.secret).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  verify(token, expectedType) {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    const want = createHmac('sha256', this.secret).update(body).digest();
    let got;
    try { got = Buffer.from(sig, 'base64url'); } catch { return null; }
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    let payload;
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
    if (expectedType && payload.typ !== expectedType) return null;
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  }
}

// Firebase anonymous UIDs are 28 characters of [A-Za-z0-9].
export function newUid() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(28);
  let out = '';
  for (let i = 0; i < 28; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
