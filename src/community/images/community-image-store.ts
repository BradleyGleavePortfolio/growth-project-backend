/**
 * SC-BE3 (agent 168): photos in the space chat (#167-7 IMAGES op 1).
 *
 * One private bucket, `community-images` (migration 20270502008500: JPEG only,
 * 10 MB, no API role may touch its objects). The phone never reads or writes
 * storage on its own: the server checks space access, then signs one upload
 * for a key it minted, checks the object at send, and signs a short-lived
 * read on every list row. The store is the voice note store with this bucket
 * and key rule, so sign, stat and the durable erasure path are the voice
 * code, unchanged (voice-erasure.ts kind 'image_object').
 *
 * Key: `<uploader id>/<space id>-<13-digit ms>-<16 hex nonce>-<32 hex mac>.jpg`.
 * The MAC (HMAC-SHA256 under the voice key secret, its own `img1` domain)
 * binds uploader, space, time and nonce, so a key is never guessable and is
 * accepted at send only by the uploader, in that space, within 24 hours.
 * Flat files under the uploader folder: account erasure empties that folder.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { VoiceUploadProvider } from '../voice/voice-upload.provider';
import { normalizesToItself, voiceKeySecret, VOICE_KEY_PUBLISH_WINDOW_MS } from '../voice/voice-storage-key';

export const COMMUNITY_IMAGES_BUCKET = 'community-images';
export const IMAGE_MIME = 'image/jpeg';
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Signed upload and read lifetimes (seconds). */
export const IMAGE_UPLOAD_TTL_SEC = 600;
export const IMAGE_READ_TTL_SEC = 900;

/** FEATURE_COMMUNITY_IMAGES: on only for the exact value "true" (default off). */
export const communityImagesEnabled = (): boolean => process.env.FEATURE_COMMUNITY_IMAGES === 'true';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY_RE = new RegExp(`^([A-Za-z0-9-]{1,64})/(${UUID})-(\\d{13})-([0-9a-f]{16})-([0-9a-f]{32})\\.jpg$`);

function macFor(secret: Buffer, owner: string, cohort: string, ts: string, nonce: string): string {
  return createHmac('sha256', secret).update(`img1|${owner}|${cohort}|${ts}|${nonce}`).digest('hex').slice(0, 32);
}

/** Shape, owner and normalization only (sign, stat, erase); never proof the server minted it. */
export function isImageStoreKey(key: string, ownerId?: string): boolean {
  const m = typeof key === 'string' ? KEY_RE.exec(key) : null;
  return !!m && (ownerId === undefined || m[1] === ownerId) && normalizesToItself(COMMUNITY_IMAGES_BUCKET, key);
}

export function mintImageKey(ownerId: string, cohortId: string, nowMs = Date.now()): string {
  const secret = voiceKeySecret();
  if (!secret) throw new ServiceUnavailableException({ error: 'unavailable', code: 'community.image.storage_unavailable' });
  const ts = String(nowMs).padStart(13, '0');
  const nonce = randomBytes(8).toString('hex');
  const key = `${ownerId}/${cohortId}-${ts}-${nonce}-${macFor(secret, ownerId, cohortId, ts, nonce)}.jpg`;
  if (!isImageStoreKey(key, ownerId)) throw new Error('image key: unsupported owner or space id');
  return key;
}

/** True only for a key this server minted for this uploader and this space, still inside its window. */
export function isPublishableImageKey(key: string, ownerId: string, cohortId: string, nowMs = Date.now()): boolean {
  const m = isImageStoreKey(key, ownerId) ? KEY_RE.exec(key) : null;
  const secret = voiceKeySecret();
  if (!m || !secret || m[2] !== cohortId) return false;
  const want = Buffer.from(macFor(secret, ownerId, cohortId, m[3], m[4]), 'utf8');
  const given = Buffer.from(m[5], 'utf8');
  const age = nowMs - Number(m[3]);
  return want.length === given.length && timingSafeEqual(want, given) && age > -300_000 && age <= VOICE_KEY_PUBLISH_WINDOW_MS;
}

export type ImageCheck = 'ok' | 'missing' | 'not_jpeg' | 'too_large' | 'unavailable';

@Injectable()
export class CommunityImageStore extends VoiceUploadProvider {
  bucket(): string {
    return COMMUNITY_IMAGES_BUCKET;
  }

  ttlSeconds(): number {
    return IMAGE_READ_TTL_SEC;
  }

  isStoreKey(key: string, ownerId?: string): boolean {
    return isImageStoreKey(key, ownerId);
  }

  /** One signed upload for a freshly minted key in this space. */
  async signUpload(ownerId: string, cohortId: string): Promise<{ upload_url: string; key: string; expires_at: string }> {
    const key = mintImageKey(ownerId, cohortId);
    try {
      const { data, error } = await this.supabase.getClient().storage.from(this.bucket()).createSignedUploadUrl(key);
      if (error || !data?.signedUrl) throw new Error(error?.message ?? 'no signed URL');
      const expires = new Date(Date.now() + IMAGE_UPLOAD_TTL_SEC * 1000).toISOString();
      return { upload_url: data.signedUrl, key, expires_at: expires };
    } catch {
      throw new ServiceUnavailableException({ error: 'unavailable', code: 'community.image.storage_unavailable' });
    }
  }

  /** At send: the object is at the exact key, says JPEG, starts with the JPEG bytes and is under the cap. */
  async check(key: string, ownerId: string): Promise<{ result: ImageCheck; size: number }> {
    const stat = await this.statObject(key, ownerId);
    if (stat.state !== 'present') return { result: stat.state, size: 0 };
    const size = stat.size ?? 0;
    if (size <= 0 || size > IMAGE_MAX_BYTES) return { result: size <= 0 ? 'missing' : 'too_large', size };
    if (stat.contentType !== IMAGE_MIME) return { result: 'not_jpeg', size };
    const url = await this.createSignedDownload(key, 60, ownerId);
    if (!url) return { result: 'unavailable', size };
    try {
      const head = new Uint8Array(await (await fetch(url, { headers: { Range: 'bytes=0-2' } })).arrayBuffer());
      return { result: head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff ? 'ok' : 'not_jpeg', size };
    } catch {
      return { result: 'unavailable', size };
    }
  }
}
