import {
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { ContractEnvelopeService } from '../contract-envelope.service';
import { SignedPdfStore } from '../signed-pdf-store.service';
import { isContractsEnabled } from '../contracts.feature';
import {
  SIGNATURE_PROVIDER,
  SignatureProvider,
  ProviderWebhookRequest,
} from '../providers/signature-provider.interface';

/**
 * B5 — HelloSign webhook (spec §3.8, §7).
 *
 * `POST /webhooks/hellosign`. Public (no JWT — the provider calls it), but
 * EVERY event MUST pass provider signature verification (HMAC-SHA256 over
 * `event_time + event_type`, keyed by the API key). An unverified event is
 * rejected with 401 and NEVER advances state (spec §7, hard gate #4).
 *
 * HelloSign transmits the event as a multipart form with a single `json`
 * field, and expects the callback to respond 200 with a body containing
 * `Hello API Event Received`. We:
 *   1. Extract the `json` field from the multipart body (falling back to a
 *      raw JSON body for non-HelloSign / test posts).
 *   2. Verify the signature off the parsed payload (401 on failure).
 *   3. If FEATURE_CONTRACTS_ENABLED is OFF: 200-ack with the required body
 *      but perform NO state mutation (spec §E). This stops provider retries
 *      while keeping the flag a hard invariant.
 *   4. Map the event → envelope transition via the service state machine
 *      (idempotent; replays on a terminal state are no-ops).
 *   5. On SIGNED: fetch + store the signed PDF and persist its reference.
 *   6. Always respond 200 with `Hello API Event Received`.
 */
@Controller('webhooks')
export class HelloSignWebhookController {
  private readonly logger = new Logger(HelloSignWebhookController.name);
  /** HelloSign requires this exact substring in the 200 response body. */
  private static readonly ACK = 'Hello API Event Received';

  constructor(
    private readonly envelopes: ContractEnvelopeService,
    private readonly pdfStore: SignedPdfStore,
    @Inject(SIGNATURE_PROVIDER)
    private readonly provider: SignatureProvider,
  ) {}

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 500 } })
  @Post('hellosign')
  @HttpCode(HttpStatus.OK)
  async handle(@Req() req: Request): Promise<string> {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      // Misconfigured middleware — never silently advance state.
      this.logger.error(
        'HelloSign webhook received without rawBody. Verify rawBody:true is wired in main.ts.',
      );
      throw new UnauthorizedException('Unverified webhook.');
    }

    const parsedBody = this.extractJsonField(req, rawBody);
    const providerReq: ProviderWebhookRequest = {
      rawBody,
      headers: req.headers as Record<string, string | string[] | undefined>,
      parsedBody,
    };

    // ── Mandatory signature verification (spec §7). 401 on any failure. ─────
    let verified = false;
    try {
      verified = this.provider.verifyWebhook(providerReq);
    } catch (err) {
      this.logger.warn(
        `HelloSign webhook verification threw: ${(err as Error).message}`,
      );
      verified = false;
    }
    if (!verified) {
      // Never advance state on an unverified event.
      throw new UnauthorizedException('Invalid webhook signature.');
    }

    // ── Flag invariant: OFF → ack but DO NOT mutate state (spec §E). ────────
    if (!isContractsEnabled()) {
      this.logger.log(
        'HelloSign webhook verified but FEATURE_CONTRACTS_ENABLED is OFF; acking without state change.',
      );
      return HelloSignWebhookController.ACK;
    }

    // ── Parse + apply. Unmapped events are a benign 200 no-op. ──────────────
    let parsed;
    try {
      parsed = this.provider.parseWebhookEvent(providerReq);
    } catch (err) {
      this.logger.log(
        `HelloSign webhook event not state-advancing: ${(err as Error).message}`,
      );
      return HelloSignWebhookController.ACK;
    }

    if (!parsed.providerRequestId) {
      this.logger.warn('HelloSign webhook missing provider request id; acking.');
      return HelloSignWebhookController.ACK;
    }

    const ip = this.ipOf(req);
    const ua = this.uaOf(req);

    const result = await this.envelopes.applyProviderEvent(
      parsed.providerRequestId,
      parsed.event,
      { ip, userAgent: ua },
    );

    // On SIGNED, fetch + persist the signed PDF. Done after the state commit
    // so a slow provider read can never block the transition (spec §3.8 #7).
    if (result.applied && parsed.event === 'SIGNED') {
      await this.captureSignedPdf(parsed.providerRequestId, result.envelope.id);
    }

    return HelloSignWebhookController.ACK;
  }

  /** Fetch the flattened signed PDF and store it; failures never 500 the ack. */
  private async captureSignedPdf(
    providerRequestId: string,
    envelopeId: string,
  ): Promise<void> {
    try {
      const { pdfBuffer } = await this.provider.fetchSignedPdf(providerRequestId);
      const ref = await this.pdfStore.store(envelopeId, pdfBuffer);
      await this.envelopes.setSignedPdfUrl(envelopeId, ref);
    } catch (err) {
      // The transition already committed; PDF capture is retried by a future
      // reconcile job. Log loudly but still 200 the provider.
      this.logger.error(
        `Failed to capture signed PDF for envelope ${envelopeId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Pull the `json` form-field out of a HelloSign multipart body. We parse it
   * ourselves (rather than depend on multer wiring on this route) so the raw
   * bytes are preserved for any future byte-exact verification. Falls back to
   * the raw body parsed as JSON for plain-JSON posts (tests / other providers).
   */
  private extractJsonField(req: Request, rawBody: Buffer): unknown {
    const contentType = String(req.headers['content-type'] ?? '');

    if (contentType.includes('multipart/form-data')) {
      const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
      const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
      if (boundary) {
        const json = this.parseMultipartField(rawBody, boundary.trim(), 'json');
        if (json) {
          try {
            return JSON.parse(json);
          } catch {
            return undefined;
          }
        }
      }
    }

    // application/json (or unknown): try the whole body as JSON.
    try {
      return JSON.parse(rawBody.toString('utf8'));
    } catch {
      // urlencoded `json=...` fallback.
      const text = rawBody.toString('utf8');
      const m = /(?:^|&)json=([^&]*)/.exec(text);
      if (m) {
        try {
          return JSON.parse(decodeURIComponent(m[1]));
        } catch {
          return undefined;
        }
      }
      return undefined;
    }
  }

  /** Minimal multipart field extractor for a single named text field. */
  private parseMultipartField(
    body: Buffer,
    boundary: string,
    fieldName: string,
  ): string | null {
    const text = body.toString('utf8');
    const delimiter = `--${boundary}`;
    const parts = text.split(delimiter);
    for (const part of parts) {
      if (
        part.includes('Content-Disposition') &&
        new RegExp(`name="${fieldName}"`).test(part)
      ) {
        // Body starts after the blank line separating headers from content.
        const idx = part.indexOf('\r\n\r\n');
        const sepLen = idx >= 0 ? 4 : part.indexOf('\n\n') >= 0 ? 2 : -1;
        const start = idx >= 0 ? idx : part.indexOf('\n\n');
        if (start < 0) continue;
        let content = part.slice(start + sepLen);
        // Strip the trailing CRLF before the next boundary.
        content = content.replace(/\r?\n--?\s*$/, '').replace(/\r?\n$/, '');
        return content.trim();
      }
    }
    return null;
  }

  private ipOf(req: Request): string | null {
    return (
      req.ip ??
      (req.socket && req.socket.remoteAddress) ??
      null
    );
  }

  private uaOf(req: Request): string | null {
    const ua = req.headers['user-agent'];
    return Array.isArray(ua) ? ua[0] : (ua ?? null);
  }
}
