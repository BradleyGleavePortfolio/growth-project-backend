import { Injectable, Logger } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCMTypes,
} from 'crypto';

// KmsService — symmetric envelope encryption used for at-rest secrets
// (Bloodwork free-text fields, Google Calendar refresh tokens).
//
// Provider:
//   Today: AES-256-GCM keyed by a base64-encoded master key in the
//   KMS_MASTER_KEY env var. This is intentionally a single-key, single-version
//   implementation — adequate for the "wrap at rest" threat model that
//   Bloodwork PR #141 and Calendar PR #192 deferred.
//
//   Tomorrow: an AwsKmsProvider (or GcpKmsProvider) can be swapped in by
//   gating on KMS_PROVIDER and adding a second provider class behind the
//   same encrypt/decrypt interface. The persisted ciphertext format is
//   versioned (`v:1`) so a future migration to a different provider does
//   NOT require re-encrypting existing rows — the new provider would
//   detect `v:1` and route to the legacy path while writing `v:2`.
//
// Failure mode:
//   If the master key is unset or malformed, encrypt() returns a
//   "PLAINTEXT:" prefixed string. This is deliberate — it lets unit
//   tests and developer machines run without secrets configured, while
//   making the unencrypted bytes grep-able in any DB dump so an operator
//   spotting them can tell at a glance that production isn't wired.
//   isConfigured() returns false in that case; callers that want to
//   require encryption (e.g. before a release-gate) can check it.

const ALGO: CipherGCMTypes = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const FORMAT_VERSION = 1;
const PLAINTEXT_MARKER = 'PLAINTEXT:';

interface EnvelopeV1 {
  v: 1;
  iv: string;
  tag: string;
  ct: string;
}

@Injectable()
export class KmsService {
  private readonly logger = new Logger(KmsService.name);
  private cachedKey: Buffer | null = null;
  private cachedKeyError: string | null = null;
  private warnedAboutMissingKey = false;

  isConfigured(): boolean {
    return this.loadKey() !== null;
  }

  keyAlias(): string {
    return process.env.KMS_KEY_ALIAS?.trim() || 'local:v1';
  }

  keyVersion(): string {
    return process.env.KMS_KEY_VERSION?.trim() || '1';
  }

  encrypt(plaintext: string): string {
    if (plaintext === '') {
      return '';
    }
    const key = this.loadKey();
    if (!key) {
      this.warnMissingKeyOnce();
      return `${PLAINTEXT_MARKER}${plaintext}`;
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    const ct = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const envelope: EnvelopeV1 = {
      v: FORMAT_VERSION,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ct: ct.toString('base64'),
    };
    return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
  }

  decrypt(ciphertext: string): string {
    if (ciphertext === '') {
      return '';
    }
    if (ciphertext.startsWith(PLAINTEXT_MARKER)) {
      return ciphertext.slice(PLAINTEXT_MARKER.length);
    }
    const key = this.loadKey();
    if (!key) {
      throw new Error(
        'KMS not configured — cannot decrypt a non-plaintext-marked value. Set KMS_MASTER_KEY.',
      );
    }
    const envelope = this.parseEnvelope(ciphertext);
    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const ct = Buffer.from(envelope.ct, 'base64');
    if (iv.length !== IV_BYTES) {
      throw new Error('KMS ciphertext rejected — IV length mismatch.');
    }
    if (tag.length !== TAG_BYTES) {
      throw new Error('KMS ciphertext rejected — auth tag length mismatch.');
    }
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  }

  private parseEnvelope(ciphertext: string): EnvelopeV1 {
    let raw: string;
    try {
      raw = Buffer.from(ciphertext, 'base64').toString('utf8');
    } catch {
      throw new Error('KMS ciphertext rejected — not valid base64.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('KMS ciphertext rejected — envelope not valid JSON.');
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as { v?: unknown }).v !== 'number'
    ) {
      throw new Error('KMS ciphertext rejected — envelope shape invalid.');
    }
    const v = (parsed as { v: number }).v;
    if (v !== FORMAT_VERSION) {
      throw new Error(
        `KMS ciphertext rejected — unsupported envelope version ${v} (expected ${FORMAT_VERSION}).`,
      );
    }
    const e = parsed as { v: 1; iv?: unknown; tag?: unknown; ct?: unknown };
    if (
      typeof e.iv !== 'string' ||
      typeof e.tag !== 'string' ||
      typeof e.ct !== 'string'
    ) {
      throw new Error('KMS ciphertext rejected — envelope fields missing.');
    }
    return { v: 1, iv: e.iv, tag: e.tag, ct: e.ct };
  }

  private loadKey(): Buffer | null {
    if (this.cachedKey) {
      return this.cachedKey;
    }
    if (this.cachedKeyError) {
      return null;
    }
    const raw = process.env.KMS_MASTER_KEY?.trim();
    if (!raw) {
      this.cachedKeyError = 'KMS_MASTER_KEY unset';
      return null;
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(raw, 'base64');
    } catch {
      this.cachedKeyError = 'KMS_MASTER_KEY not valid base64';
      return null;
    }
    if (buf.length !== KEY_BYTES) {
      this.cachedKeyError = `KMS_MASTER_KEY wrong length: got ${buf.length} bytes, expected ${KEY_BYTES}`;
      return null;
    }
    this.cachedKey = buf;
    return buf;
  }

  private warnMissingKeyOnce(): void {
    if (this.warnedAboutMissingKey) {
      return;
    }
    this.warnedAboutMissingKey = true;
    this.logger.warn(
      `KMS not configured — secrets will be persisted with a ${PLAINTEXT_MARKER} prefix. Set KMS_MASTER_KEY before production.`,
    );
  }

  // Test-only seam: clears cached key + warn state so a spec can toggle
  // KMS_MASTER_KEY between cases without restarting the service.
  resetForTests(): void {
    this.cachedKey = null;
    this.cachedKeyError = null;
    this.warnedAboutMissingKey = false;
  }
}
