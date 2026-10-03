import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Voice storage keys (A-610-1).
 *
 * A voice object lives at `<bucket>/<ownerId>/<file>` in Supabase Storage. The
 * service-role client signs any path it is given, so a key is never trusted
 * just because it starts with the caller's id: `<me>/../victim/x.m4a` passes a
 * prefix check, and the storage SDK then builds
 * `/object/sign/<bucket>/<me>/../victim/x.m4a`, which standard URL
 * normalization (WHATWG, what fetch applies) turns into another principal's
 * object or another bucket.
 *
 * So every key is checked in three ways:
 *  1. Shape: a strict allowlist regex (`ownerId/file.ext`, letters, digits and
 *     dashes only; no dot segment, no `%`, no `\`, no `//`, no query or hash).
 *  2. Normalization: the exact request path the installed SDK builds
 *     (`_getFinalPath`: `${bucket}/${key.replace(/^\/+/, '')}`) must survive
 *     URL normalization unchanged and stay under `<bucket>/<ownerId>/`.
 *  3. Issuance (publish only): the file name carries an HMAC over the owner,
 *     time, nonce and extension, so only a key the server minted for THIS
 *     caller, recently, can be published.
 */

/** Extensions the server mints (VoiceUploadProvider.contentTypeToExt). */
export const VOICE_KEY_EXTENSIONS = ['m4a', 'aac', 'mp3', 'webm', 'wav', 'ogg'] as const;

const OWNER_RE = /^[A-Za-z0-9-]{1,64}$/;
/** Minted community voice key: `<owner>/<13-digit ms>-<16 hex nonce>-<32 hex mac>.<ext>`. */
const MINTED_RE =
  /^([A-Za-z0-9-]{1,64})\/(\d{13})-([0-9a-f]{16})-([0-9a-f]{32})\.(m4a|aac|mp3|webm|wav|ogg)$/;
/**
 * Any key the server ever minted, including the pre-HMAC shape
 * `<owner>/<ms>-<16 hex>.<ext>` still on older rows: safe to SIGN (read),
 * never accepted for a new publish.
 */
const SIGNABLE_RE = /^([A-Za-z0-9-]{1,64})\/([A-Za-z0-9-]{1,120})\.(m4a|aac|mp3|webm|wav|ogg|bin)$/;

/** How long after minting a key may still be published (upload TTL max + slack). */
export const VOICE_KEY_PUBLISH_WINDOW_MS = 24 * 60 * 60 * 1000 + 10 * 60 * 1000;

export interface MintedVoiceKey {
  ownerId: string;
  mintedAtMs: number;
  nonce: string;
  mac: string;
  ext: string;
}

/**
 * The secret behind the issuance MAC: VOICE_KEY_SIGNING_SECRET when set, else
 * a value derived from the Supabase service-role key (always present wherever
 * storage works; without it no upload URL can be minted either). Null when
 * neither is configured, which makes every publish fail closed.
 */
export function voiceKeySecret(): Buffer | null {
  const explicit = (process.env.VOICE_KEY_SIGNING_SECRET ?? '').trim();
  const base = explicit || (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!base) return null;
  return createHmac('sha256', 'tgp.community.voice-key.v1').update(base).digest();
}

function macFor(secret: Buffer, ownerId: string, ts: string, nonce: string, ext: string): string {
  return createHmac('sha256', secret)
    .update(`v1|${ownerId}|${ts}|${nonce}|${ext}`)
    .digest('hex')
    .slice(0, 32);
}

/** Mint a new key for `ownerId`. Throws when the owner id or secret is unusable. */
export function mintVoiceKey(ownerId: string, ext: string, nowMs: number = Date.now()): string {
  if (!OWNER_RE.test(ownerId)) throw new Error('voice key: unsupported owner id');
  if (!(VOICE_KEY_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new Error('voice key: unsupported extension');
  }
  const secret = voiceKeySecret();
  if (!secret) throw new Error('voice key: signing secret not configured');
  const ts = String(nowMs).padStart(13, '0');
  const nonce = randomBytes(8).toString('hex');
  return `${ownerId}/${ts}-${nonce}-${macFor(secret, ownerId, ts, nonce, ext)}.${ext}`;
}

/**
 * The request path the installed storage SDK builds for a key, after the URL
 * normalization fetch applies. Mirrors StorageFileApi._getFinalPath exactly.
 */
export function normalizedSdkObjectPath(bucket: string, key: string): string {
  const finalPath = `${bucket}/${key.replace(/^\/+/, '')}`;
  return new URL(`https://storage.invalid/object/sign/${finalPath}`).pathname;
}

/**
 * True when the key, once normalized the way the SDK + fetch do it, addresses
 * exactly `<bucket>/<key>` (nothing collapsed, decoded or re-encoded).
 */
export function normalizesToItself(bucket: string, key: string): boolean {
  try {
    return normalizedSdkObjectPath(bucket, key) === `/object/sign/${bucket}/${key}`;
  } catch {
    return false;
  }
}

/**
 * Safe to sign for READ: canonical shape, normalization-stable, and (when an
 * owner is given) inside that owner's folder. Used before EVERY signing call.
 */
export function isSignableVoiceKey(bucket: string, key: string, ownerId?: string): boolean {
  if (typeof key !== 'string' || key.length === 0 || key.length > 200) return false;
  const m = SIGNABLE_RE.exec(key);
  if (!m) return false;
  if (ownerId !== undefined && m[1] !== ownerId) return false;
  return normalizesToItself(bucket, key);
}

/** Parse a minted (HMAC) key, or null when the shape does not match. */
export function parseMintedVoiceKey(key: string): MintedVoiceKey | null {
  const m = MINTED_RE.exec(key);
  if (!m) return null;
  return { ownerId: m[1], mintedAtMs: Number(m[2]), nonce: m[3], mac: m[4], ext: m[5] };
}

export type VoiceKeyRejection =
  'shape' | 'owner' | 'normalization' | 'signature' | 'expired' | 'secret_missing';

/**
 * Publish-time check: the key must be one the server minted for `ownerId`
 * (valid MAC), within the publish window, normalization-stable in `bucket`.
 */
export function verifyPublishableVoiceKey(
  bucket: string,
  key: string,
  ownerId: string,
  nowMs: number = Date.now(),
): { ok: true; parsed: MintedVoiceKey } | { ok: false; reason: VoiceKeyRejection } {
  const parsed = typeof key === 'string' ? parseMintedVoiceKey(key) : null;
  if (!parsed) return { ok: false, reason: 'shape' };
  if (parsed.ownerId !== ownerId) return { ok: false, reason: 'owner' };
  if (!normalizesToItself(bucket, key)) return { ok: false, reason: 'normalization' };
  const secret = voiceKeySecret();
  if (!secret) return { ok: false, reason: 'secret_missing' };
  const ts = String(parsed.mintedAtMs).padStart(13, '0');
  const expected = Buffer.from(macFor(secret, ownerId, ts, parsed.nonce, parsed.ext), 'utf8');
  const given = Buffer.from(parsed.mac, 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'signature' };
  }
  const age = nowMs - parsed.mintedAtMs;
  if (age < -5 * 60 * 1000 || age > VOICE_KEY_PUBLISH_WINDOW_MS) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, parsed };
}

/** Owner folder for account-deletion cleanup (`<ownerId>`), or null when unusable. */
export function voiceOwnerFolder(ownerId: string): string | null {
  return OWNER_RE.test(ownerId) ? ownerId : null;
}
