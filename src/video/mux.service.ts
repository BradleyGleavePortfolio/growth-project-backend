/**
 * MuxService — thin adapter over the Mux REST API.
 *
 * Scope: just the calls the video-library v1 path needs.
 *   - createDirectUpload()   — owner uploads a new exercise demo
 *   - getAsset()             — webhook handler look-up
 *   - mintPlaybackUrl()      — detail endpoint per-request URL minting
 *   - verifyWebhookSignature — webhook controller HMAC check
 *
 * Configuration:
 *
 *   MUX_TOKEN_ID, MUX_TOKEN_SECRET     — REST API Basic auth (required for
 *                                        any owner-side action; missing means
 *                                        the upload/attach routes 503).
 *   MUX_WEBHOOK_SECRET                 — HMAC secret for Mux's
 *                                        Mux-Signature header.
 *   MUX_SIGNING_KEY_ID,
 *   MUX_SIGNING_KEY_PRIVATE            — Used when an asset has
 *                                        `signed` playback policy. v1
 *                                        defaults to 'public' so these
 *                                        are optional.
 *
 * No-fake-URL rule: when MUX_TOKEN_ID/SECRET are missing, every method
 * that needs them throws `MuxDisabledError` immediately. No placeholder
 * playback IDs, no synthetic asset rows. The detail-endpoint contract
 * with the mobile client is "playbackUrl is null when no video" — that
 * null comes from the absence of a stored `mux_playback_id`, never from
 * a fake URL.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createHmac,
  createSign,
  timingSafeEqual,
} from 'crypto';
import { MuxApiError, MuxDisabledError } from './mux.errors';

const MUX_API_BASE = 'https://api.mux.com';
const SIGNED_URL_DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour

export interface CreateDirectUploadResult {
  uploadId: string;
  url: string;
}

export interface MuxAsset {
  id: string;
  status: 'preparing' | 'ready' | 'errored';
  playbackIds: Array<{ id: string; policy: 'public' | 'signed' }>;
  duration?: number;
  errors?: { type?: string; messages?: string[] };
  uploadId?: string;
}

export interface MintPlaybackUrlInput {
  playbackId: string;
  policy: 'public' | 'signed';
  /** Seconds the signed URL stays valid for. Ignored for `public`. */
  ttlSeconds?: number;
}

@Injectable()
export class MuxService {
  private readonly logger = new Logger(MuxService.name);

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return !!(this.tokenId && this.tokenSecret);
  }

  // ── public API ──────────────────────────────────────────────────────────

  /**
   * Create a Mux Direct Upload. Returns the signed URL the client uploads
   * the video file to, plus the upload id (stored on the catalog row so
   * the webhook can resolve back when Mux finishes processing).
   *
   * Throws MuxDisabledError when Mux secrets are absent. Callers should
   * translate that into a 503.
   */
  async createDirectUpload(opts: {
    playbackPolicy?: 'public' | 'signed';
    corsOrigin?: string;
  } = {}): Promise<CreateDirectUploadResult> {
    if (!this.isConfigured()) {
      throw new MuxDisabledError(
        'Set MUX_TOKEN_ID and MUX_TOKEN_SECRET to enable video uploads.',
      );
    }
    const policy = opts.playbackPolicy ?? 'public';
    const body = {
      new_asset_settings: {
        playback_policy: [policy],
      },
      cors_origin: opts.corsOrigin ?? '*',
    };
    const json = await this.muxFetch<{
      data: { id: string; url: string };
    }>('POST', '/video/v1/uploads', body);
    return { uploadId: json.data.id, url: json.data.url };
  }

  /** Fetch the full asset record. Used by the webhook handler. */
  async getAsset(assetId: string): Promise<MuxAsset> {
    if (!this.isConfigured()) {
      throw new MuxDisabledError(
        'Set MUX_TOKEN_ID and MUX_TOKEN_SECRET to fetch Mux assets.',
      );
    }
    const json = await this.muxFetch<{
      data: {
        id: string;
        status: MuxAsset['status'];
        playback_ids?: Array<{ id: string; policy: 'public' | 'signed' }>;
        duration?: number;
        errors?: { type?: string; messages?: string[] };
        upload_id?: string;
      };
    }>('GET', `/video/v1/assets/${encodeURIComponent(assetId)}`);
    return {
      id: json.data.id,
      status: json.data.status,
      playbackIds: json.data.playback_ids ?? [],
      duration: json.data.duration,
      errors: json.data.errors,
      uploadId: json.data.upload_id,
    };
  }

  /**
   * Mint a playback URL for an exercise.
   *
   *   - policy=public: return the bare HLS URL. Mux serves the manifest
   *     without auth. Suitable for the unauthenticated public preview
   *     case if a coach wants to share a workout.
   *   - policy=signed: mint a per-request JWT signed by
   *     MUX_SIGNING_KEY_PRIVATE; URL embeds the token as `?token=`.
   *     Required when the catalog row was created with the `signed`
   *     playback policy. Throws MuxDisabledError if signing-key env
   *     vars are not set.
   *
   * This method DOES NOT require MUX_TOKEN_ID/SECRET — only the signing
   * key. We deliberately keep them separate so a deploy with read-only
   * playback secrets (no API token, no webhook secret) still mints URLs.
   */
  mintPlaybackUrl(input: MintPlaybackUrlInput): string {
    const base = `https://stream.mux.com/${encodeURIComponent(input.playbackId)}.m3u8`;
    if (input.policy === 'public') {
      return base;
    }
    const keyId = this.config.get<string>('MUX_SIGNING_KEY_ID');
    const keyPrivate = this.config.get<string>('MUX_SIGNING_KEY_PRIVATE');
    if (!keyId || !keyPrivate) {
      throw new MuxDisabledError(
        'Signed playback requires MUX_SIGNING_KEY_ID and MUX_SIGNING_KEY_PRIVATE.',
      );
    }
    const ttl = input.ttlSeconds ?? SIGNED_URL_DEFAULT_TTL_SECONDS;
    const token = this.signPlaybackJwt({
      playbackId: input.playbackId,
      keyId,
      keyPrivate,
      ttlSeconds: ttl,
    });
    return `${base}?token=${encodeURIComponent(token)}`;
  }

  /**
   * Verify a Mux webhook signature header.
   *
   * Format: "t=<unix_ts>,v1=<hex_signature>"
   * Signed payload: "<t>.<raw_body>"
   * MAC: HMAC-SHA256 keyed by MUX_WEBHOOK_SECRET.
   *
   * Mirrors the Stripe webhook signature verification in
   * src/billing/stripe-signature.ts (same algorithm; Mux happens to use
   * the same shape).
   *
   * Returns true on a valid signature. Returns false (does NOT throw)
   * on any failure mode so the controller can map cleanly to 400. The
   * caller decides whether to log the rejection.
   */
  verifyWebhookSignature(opts: {
    payload: string;
    signatureHeader: string | undefined | null;
    toleranceSeconds?: number;
    now?: () => number;
  }): boolean {
    const secret = this.config.get<string>('MUX_WEBHOOK_SECRET');
    if (!secret) return false;
    const header = opts.signatureHeader;
    if (!header) return false;

    const tolerance = opts.toleranceSeconds ?? 300;
    const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

    const parts: Record<string, string[]> = {};
    for (const seg of header.split(',')) {
      const eq = seg.indexOf('=');
      if (eq === -1) continue;
      const k = seg.slice(0, eq).trim();
      const v = seg.slice(eq + 1).trim();
      (parts[k] ||= []).push(v);
    }
    const tStr = parts['t']?.[0];
    const v1List = parts['v1'] ?? [];
    if (!tStr || v1List.length === 0) return false;
    const t = Number(tStr);
    if (!Number.isFinite(t)) return false;
    if (Math.abs(now() - t) > tolerance) return false;

    const signed = `${tStr}.${opts.payload}`;
    const expected = createHmac('sha256', secret)
      .update(signed, 'utf8')
      .digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    for (const v1 of v1List) {
      let candidate: Buffer;
      try {
        candidate = Buffer.from(v1, 'hex');
      } catch {
        continue;
      }
      if (
        candidate.length === expectedBuf.length &&
        timingSafeEqual(candidate, expectedBuf)
      ) {
        return true;
      }
    }
    return false;
  }

  // ── internals ───────────────────────────────────────────────────────────

  private get tokenId(): string {
    return this.config.get<string>('MUX_TOKEN_ID') ?? '';
  }

  private get tokenSecret(): string {
    return this.config.get<string>('MUX_TOKEN_SECRET') ?? '';
  }

  private async muxFetch<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const auth = Buffer.from(`${this.tokenId}:${this.tokenSecret}`).toString(
      'base64',
    );
    const res = await fetch(`${MUX_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new MuxApiError(
        res.status,
        `Mux API error ${res.status}: ${text.slice(0, 300)}`,
      );
    }
    return (await res.json()) as T;
  }

  /**
   * Sign a Mux playback JWT.
   *
   * Mux signed playback uses RS256 over the standard JOSE shape with
   *   header  = { alg: 'RS256', kid: <signing key id>, typ: 'JWT' }
   *   payload = { sub: <playback id>, aud: 'v', exp: <unix>, kid: <signing key id> }
   *
   * The private key arrives as a PEM (or a base64-wrapped PEM, which is
   * how Fly stores multi-line secrets); we accept either.
   */
  private signPlaybackJwt(opts: {
    playbackId: string;
    keyId: string;
    keyPrivate: string;
    ttlSeconds: number;
  }): string {
    const header = { alg: 'RS256', kid: opts.keyId, typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: opts.playbackId,
      aud: 'v',
      exp: now + opts.ttlSeconds,
      kid: opts.keyId,
    };
    const b64url = (buf: Buffer): string =>
      buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const headerSegment = b64url(Buffer.from(JSON.stringify(header), 'utf8'));
    const payloadSegment = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
    const signingInput = `${headerSegment}.${payloadSegment}`;

    // Accept the private key either as a literal PEM or as a base64-
    // wrapped PEM. The Mux docs ship a base64 blob; the wrapping is just
    // newline-safe transport. If the value isn't a PEM after stripping
    // surrounding whitespace, try to base64-decode it.
    const pem = this.coerceToPem(opts.keyPrivate);
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    const signature = signer.sign(pem);
    return `${signingInput}.${b64url(signature)}`;
  }

  private coerceToPem(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.startsWith('-----BEGIN ')) return trimmed;
    // Treat as base64-wrapped PEM.
    try {
      const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
      if (decoded.startsWith('-----BEGIN ')) return decoded;
    } catch {
      // fall through
    }
    throw new MuxDisabledError(
      'MUX_SIGNING_KEY_PRIVATE is not a recognizable PEM or base64-PEM blob.',
    );
  }
}
