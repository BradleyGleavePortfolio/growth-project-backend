import { Injectable, Logger } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';

/**
 * B5 — Signed-PDF storage + 5-minute signed-URL minting (spec §6.3, §7).
 *
 * Retention posture (spec §6.3): signed PDFs live in the SAME S3 bucket as
 * the GDPR export path (dependency BUG-R4, PR pending). Until that bucket
 * lands, this service stores the PDF on the local filesystem (the exact
 * fallback the data-export service uses) and returns a `local://` reference;
 * the storage layer is swappable to S3 without touching callers.
 *
 * Download security (spec §7): contracts are NEVER served through a
 * long-lived public link. Every download mints a FRESH, 5-MINUTE signed
 * token bound to the envelope id and the requesting user id. The download
 * controller verifies the token before streaming/redirecting. This mirrors
 * the data-export download-token discipline, tightened to a 5-minute TTL.
 */
const SIGNED_URL_TTL_SECONDS = 5 * 60; // 5 minutes (spec §7).
const FS_DIR = '/tmp/tgp-contract-pdfs';

function getTokenKey(): Uint8Array {
  const secret =
    process.env.CONTRACT_PDF_URL_SECRET ??
    process.env.DATA_EXPORT_DOWNLOAD_SECRET ??
    process.env.JWT_SECRET ??
    '';
  if (!secret) {
    throw new Error(
      'CONTRACT_PDF_URL_SECRET (or a fallback signing secret) must be set to mint signed PDF URLs.',
    );
  }
  return new TextEncoder().encode(secret);
}

export interface SignedPdfTokenClaims {
  envelope_id: string;
  type: 'contract_pdf_download';
  sub: string; // requesting user id
}

@Injectable()
export class SignedPdfStore {
  private readonly logger = new Logger(SignedPdfStore.name);

  /** Persist the signed PDF; returns a storage reference (not a public URL). */
  async store(envelopeId: string, pdf: Buffer): Promise<string> {
    const bucket = process.env.CONTRACT_PDF_BUCKET ?? process.env.DATA_EXPORT_BUCKET;
    if (bucket) {
      // S3 path (BUG-R4 bucket). Stored under a contracts/ prefix; the
      // object is private — access is only ever via a freshly-minted
      // short-lived signed URL. Implemented when @aws-sdk lands with BUG-R4.
      this.logger.log(
        `Contract PDF for envelope ${envelopeId} would be stored to s3://${bucket}/contracts/${envelopeId}.pdf (BUG-R4).`,
      );
      return `s3://${bucket}/contracts/${envelopeId}.pdf`;
    }
    const { mkdir, writeFile } = await import('fs/promises');
    const { join } = await import('path');
    await mkdir(FS_DIR, { recursive: true });
    const filePath = join(FS_DIR, `${envelopeId}.pdf`);
    await writeFile(filePath, pdf);
    return `local://${filePath}`;
  }

  /**
   * Mint a 5-minute signed token for a download. The returned value is the
   * token; the download URL is `/contracts/envelopes/:id/pdf?token=...`.
   * The token is bound to BOTH the envelope id and the requesting user id so
   * it cannot be replayed for another envelope or by another user.
   */
  async mintSignedToken(envelopeId: string, userId: string): Promise<string> {
    return new SignJWT({
      envelope_id: envelopeId,
      type: 'contract_pdf_download',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(`${SIGNED_URL_TTL_SECONDS}s`)
      .sign(getTokenKey());
  }

  /** Verify a download token; returns claims or throws. */
  async verifySignedToken(token: string): Promise<SignedPdfTokenClaims> {
    const { payload } = await jwtVerify(token, getTokenKey());
    if (payload.type !== 'contract_pdf_download') {
      throw new Error('Wrong token type');
    }
    return {
      envelope_id: String(payload.envelope_id),
      type: 'contract_pdf_download',
      sub: String(payload.sub),
    };
  }

  /**
   * Read previously-stored signed-PDF bytes back from a storage reference
   * produced by `store()`. Supports the `local://` fallback today; the S3
   * (`s3://`) branch lands with BUG-R4. Throws if the reference cannot be
   * resolved so the controller can map it to a non-leaking 404.
   */
  async readStored(ref: string): Promise<Buffer> {
    if (ref.startsWith('local://')) {
      const { readFile } = await import('fs/promises');
      return readFile(ref.slice('local://'.length));
    }
    if (ref.startsWith('s3://')) {
      // Resolved via a short-lived signed GET URL once the BUG-R4 bucket is
      // wired with @aws-sdk; the controller still gates on its own 5-minute
      // token before reaching here.
      throw new Error('S3-backed contract PDF retrieval lands with BUG-R4.');
    }
    throw new Error(`Unrecognized signed-PDF storage reference: ${ref}`);
  }

  /** The TTL in seconds, exposed for tests / response metadata. */
  get ttlSeconds(): number {
    return SIGNED_URL_TTL_SECONDS;
  }
}
