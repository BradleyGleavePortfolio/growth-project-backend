import * as crypto from 'crypto';

/**
 * B-DIGEST-127 — the links inside the nightly and weekly digest emails.
 *
 * Every link points at a route this backend serves itself on its public
 * host (the same host that serves /privacy, /help and /billing/update-card):
 *   - the "Open the app" button      -> GET  /open
 *   - the footer unsubscribe link    -> GET  /email/unsubscribe?t=<token>
 *   - the List-Unsubscribe header    -> POST /email/unsubscribe?t=<token>
 *     (RFC 8058 one-click; mail apps POST "List-Unsubscribe=One-Click")
 *
 * The host is a constant, like DUNNING_UPDATE_CARD_URL, on purpose: the old
 * APP_URL / CONSOLE_URL bases pointed at hosts that do not exist, and their
 * Fly values are not known, so no env value decides where a digest link goes.
 *
 * Unsubscribe token: `v1.<base64url user id>.<kind>.<expiry seconds>.<mac>`,
 * mac = HMAC-SHA256 over everything before it, keyed with a key derived from
 * RECENT_AUTH_SECRET under a fixed label (the deletion-receipt precedent; that
 * secret is required at production boot, so no new secret is needed). The
 * kind is bound into the mac, so a token for one email kind cannot switch off
 * another. Without the key no token is minted and no digest is sent.
 */
export const DIGEST_PUBLIC_ORIGIN = 'https://app.trygrowthproject.com';
export const DIGEST_OPEN_APP_PATH = '/open';
export const EMAIL_UNSUBSCRIBE_PATH = '/email/unsubscribe';
export const DIGEST_OPEN_APP_URL = `${DIGEST_PUBLIC_ORIGIN}${DIGEST_OPEN_APP_PATH}`;

/** Email kinds a link can switch off, and the preference field each one sets false. */
export const UNSUBSCRIBE_KINDS = { digest: 'digest_email' } as const;
export type UnsubscribeKind = keyof typeof UNSUBSCRIBE_KINDS;

export const UNSUBSCRIBE_TOKEN_TTL_DAYS = 60;
const KEY_LABEL = 'tgp.email-unsubscribe.key.v1';
const MIN_SECRET_LENGTH = 32;
const VERSION = 'v1';

export class UnsubscribeKeyMissingError extends Error {
  constructor() {
    super('UNSUBSCRIBE_KEY_MISSING');
    this.name = 'UnsubscribeKeyMissingError';
  }
}

function unsubscribeKey(env: NodeJS.ProcessEnv): Buffer | null {
  const base = (env.RECENT_AUTH_SECRET ?? '').trim();
  if (base.length < MIN_SECRET_LENGTH) return null;
  return crypto.createHmac('sha256', KEY_LABEL).update(base).digest();
}

function mac(key: Buffer, payload: string): string {
  return crypto.createHmac('sha256', key).update(payload).digest('base64url');
}

function isKind(v: string): v is UnsubscribeKind {
  return Object.prototype.hasOwnProperty.call(UNSUBSCRIBE_KINDS, v);
}

/** A signed, expiring unsubscribe token for one user and one email kind. */
export function signUnsubscribeToken(
  userId: string,
  kind: UnsubscribeKind,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const key = unsubscribeKey(env);
  if (!key) throw new UnsubscribeKeyMissingError();
  const exp = Math.floor(now.getTime() / 1000) + UNSUBSCRIBE_TOKEN_TTL_DAYS * 24 * 60 * 60;
  const payload = `${VERSION}.${Buffer.from(userId, 'utf8').toString('base64url')}.${kind}.${exp}`;
  return `${payload}.${mac(key, payload)}`;
}

export type UnsubscribeTokenCheck =
  | { ok: true; userId: string; kind: UnsubscribeKind }
  | { ok: false; reason: 'invalid' | 'expired' };

/** Verify a token: signature first (constant-time), then expiry. */
export function verifyUnsubscribeToken(
  token: unknown,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): UnsubscribeTokenCheck {
  const key = unsubscribeKey(env);
  if (!key || typeof token !== 'string' || token.length > 512) return { ok: false, reason: 'invalid' };
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) return { ok: false, reason: 'invalid' };
  const [, userPart, kind, expPart, given] = parts;
  const expected = Buffer.from(mac(key, parts.slice(0, 4).join('.')), 'utf8');
  const actual = Buffer.from(given, 'utf8');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'invalid' };
  }
  const userId = Buffer.from(userPart, 'base64url').toString('utf8');
  if (!isKind(kind) || !/^\d{1,12}$/.test(expPart) || userId.length === 0) {
    return { ok: false, reason: 'invalid' };
  }
  if (Number(expPart) * 1000 < now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, userId, kind };
}

export interface DigestLinks {
  openAppUrl: string;
  unsubscribeUrl: string;
  headers: Record<string, string>;
}

/** The links and List-Unsubscribe headers for one recipient's digest. */
export function digestLinksFor(
  userId: string,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): DigestLinks {
  const token = signUnsubscribeToken(userId, 'digest', now, env);
  const unsubscribeUrl = `${DIGEST_PUBLIC_ORIGIN}${EMAIL_UNSUBSCRIBE_PATH}?t=${encodeURIComponent(token)}`;
  return {
    openAppUrl: DIGEST_OPEN_APP_URL,
    unsubscribeUrl,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
