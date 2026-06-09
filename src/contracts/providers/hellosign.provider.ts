import { createHmac, timingSafeEqual } from 'crypto';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CreateSignatureRequestInput,
  CreateSignatureRequestResult,
  ParsedWebhookEvent,
  ProviderWebhookRequest,
  SignatureProvider,
} from './signature-provider.interface';

/**
 * B5 — HelloSign (Dropbox Sign) provider, v1 default (spec §2, §3.6).
 *
 * UX = the **Embedded** plan: the signing surface loads in an inline iframe
 * (no redirect), which is the entire premise of the inline-before-Stripe
 * checkout flow. We mint a fresh, short-lived embed URL per request.
 *
 * SDK posture (operator decision, brief workflow step 3): the official
 * `@dropbox/sign` npm package is the declared dependency (AWS-SDK-as-core-dep
 * precedent). To keep the unit/integration suite runnable WITHOUT a live
 * HelloSign account or the SDK installed in every sandbox, the SDK is loaded
 * lazily via `require()` inside the network methods (createSignatureRequest /
 * fetchSignedPdf / refreshEmbedUrl). Those methods only ever execute when
 * `FEATURE_CONTRACTS_ENABLED` is ON (the service gate runs first), and in
 * tests the whole provider is replaced by a fake bound to SIGNATURE_PROVIDER.
 * The signature-verification path (verifyWebhook / parseWebhookEvent) uses
 * only Node's `crypto` and runs in every environment, because that is the
 * security-critical path the suite must cover (spec §7, hard gate #4).
 *
 * Webhook signature scheme (HelloSign "Events Walkthrough"): every event
 * payload carries an `event_hash` = HMAC-SHA256, key = the account API key,
 * message = `event_time + event_type` (concatenated). We recompute and
 * compare in constant time; mismatch → false (the controller maps that to
 * 401 and NEVER advances state). HelloSign posts the event as a multipart
 * form with a single `json` field; the controller passes the parsed JSON via
 * `parsedBody` and the raw bytes via `rawBody`.
 *
 * Env: `HELLOSIGN_API_KEY` (rotate quarterly; never logged), and
 * `HELLOSIGN_CLIENT_ID` for the embedded app. Both read lazily so the module
 * boots even when contracts are OFF and the keys are absent.
 */
@Injectable()
export class HelloSignProvider implements SignatureProvider {
  readonly providerKey = 'hellosign';
  private readonly logger = new Logger(HelloSignProvider.name);

  private apiKey(): string {
    const k = process.env.HELLOSIGN_API_KEY;
    if (!k) {
      throw new ServiceUnavailableException({
        error: 'CONTRACTS_PROVIDER_UNCONFIGURED',
        message: 'E-signature provider is not configured.',
      });
    }
    return k;
  }

  private clientId(): string {
    const c = process.env.HELLOSIGN_CLIENT_ID;
    if (!c) {
      throw new ServiceUnavailableException({
        error: 'CONTRACTS_PROVIDER_UNCONFIGURED',
        message: 'E-signature provider is not configured.',
      });
    }
    return c;
  }

  /**
   * Lazily resolve the official `@dropbox/sign` SDK; clear error if the dep
   * is missing. Typed as a structural shape (not `import('@dropbox/sign')`)
   * so tsc compiles in sandboxes where the package isn't installed — the
   * real SDK satisfies this shape at runtime in prod/CI.
   */
  private sdk(): HelloSignSdk {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('@dropbox/sign') as HelloSignSdk;
    } catch {
      throw new ServiceUnavailableException({
        error: 'CONTRACTS_PROVIDER_SDK_MISSING',
        message: 'E-signature provider SDK is not installed.',
      });
    }
  }

  async createSignatureRequest(
    input: CreateSignatureRequestInput,
  ): Promise<CreateSignatureRequestResult> {
    const sdk = this.sdk();
    const api = new sdk.SignatureRequestApi();
    api.username = this.apiKey();

    // The client is the (single) signer; the coach is CC'd as a copy
    // recipient on the signed PDF. The {{client.signature_block}} merge
    // anchor in the rendered body maps to HelloSign text-tag signing.
    const signer = {
      emailAddress: input.client.email,
      name: input.client.name,
      order: 0,
    };

    const res = await api.signatureRequestCreateEmbedded({
      clientId: this.clientId(),
      title: input.title,
      subject: input.title,
      signers: [signer],
      ccEmailAddresses: [input.coach.email],
      // Send the rendered HTML as the document. HelloSign accepts a file
      // payload; we wrap the HTML so text-tags resolve to signature anchors.
      files: [Buffer.from(input.renderedHtml, 'utf8')],
      useTextTags: true,
      hideTextTags: true,
      testMode: process.env.HELLOSIGN_TEST_MODE === 'true',
      metadata: { tgp_envelope_id: input.envelopeId },
    });

    const requestId =
      res.body?.signatureRequest?.signatureRequestId ?? '';
    if (!requestId) {
      throw new ServiceUnavailableException({
        error: 'CONTRACTS_PROVIDER_NO_REQUEST_ID',
        message: 'E-signature provider did not return a request id.',
      });
    }
    const signatureId =
      res.body?.signatureRequest?.signatures?.[0]?.signatureId ?? '';
    const embedUrl = await this.embedUrlForSignature(signatureId);
    return { providerRequestId: requestId, embedUrl };
  }

  async refreshEmbedUrl(
    providerRequestId: string,
  ): Promise<{ embedUrl: string }> {
    const sdk = this.sdk();
    const reqApi = new sdk.SignatureRequestApi();
    reqApi.username = this.apiKey();
    const detail = await reqApi.signatureRequestGet(providerRequestId);
    const signatureId =
      detail.body?.signatureRequest?.signatures?.[0]?.signatureId ?? '';
    const embedUrl = await this.embedUrlForSignature(signatureId);
    return { embedUrl };
  }

  private async embedUrlForSignature(signatureId: string): Promise<string> {
    if (!signatureId) {
      throw new ServiceUnavailableException({
        error: 'CONTRACTS_PROVIDER_NO_SIGNATURE_ID',
        message: 'E-signature provider did not return a signature id.',
      });
    }
    const sdk = this.sdk();
    const embeddedApi = new sdk.EmbeddedApi();
    embeddedApi.username = this.apiKey();
    const res = await embeddedApi.embeddedSignUrl(signatureId);
    const url = res.body?.embedded?.signUrl ?? '';
    if (!url) {
      throw new ServiceUnavailableException({
        error: 'CONTRACTS_PROVIDER_NO_EMBED_URL',
        message: 'E-signature provider did not return an embed URL.',
      });
    }
    return url;
  }

  async fetchSignedPdf(
    providerRequestId: string,
  ): Promise<{ pdfBuffer: Buffer }> {
    const sdk = this.sdk();
    const api = new sdk.SignatureRequestApi();
    api.username = this.apiKey();
    // `files` with fileType=pdf returns the flattened signed PDF bytes.
    const res = await api.signatureRequestFiles(providerRequestId, 'pdf');
    const data = (res as { body?: unknown }).body;
    if (Buffer.isBuffer(data)) return { pdfBuffer: data };
    if (data instanceof ArrayBuffer) return { pdfBuffer: Buffer.from(data) };
    if (typeof data === 'string')
      return { pdfBuffer: Buffer.from(data, 'binary') };
    throw new ServiceUnavailableException({
      error: 'CONTRACTS_PROVIDER_PDF_UNAVAILABLE',
      message: 'E-signature provider did not return a signed PDF.',
    });
  }

  // ─── Webhook security (crypto-only; runs in every environment) ──────────────

  /**
   * Recompute the HelloSign `event_hash` and compare in constant time.
   * Returns false on ANY problem (missing fields, bad hex, length mismatch)
   * so the controller can reject with 401 and never advance state.
   */
  verifyWebhook(req: ProviderWebhookRequest): boolean {
    const evt = this.extractEventObject(req);
    if (!evt) return false;
    const { eventTime, eventType, eventHash } = evt;
    if (!eventTime || !eventType || !eventHash) return false;

    let expectedHex: string;
    try {
      expectedHex = createHmac('sha256', this.apiKeyForVerify())
        .update(`${eventTime}${eventType}`)
        .digest('hex');
    } catch {
      return false;
    }

    // Constant-time compare on equal-length buffers.
    const a = Buffer.from(expectedHex, 'utf8');
    const b = Buffer.from(String(eventHash), 'utf8');
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /** Verification must fail (not throw) when the key is unset. */
  private apiKeyForVerify(): string {
    const k = process.env.HELLOSIGN_API_KEY;
    if (!k) throw new Error('HELLOSIGN_API_KEY unset');
    return k;
  }

  parseWebhookEvent(req: ProviderWebhookRequest): ParsedWebhookEvent {
    const evt = this.extractEventObject(req);
    if (!evt) {
      throw new ServiceUnavailableException('Unparseable HelloSign event');
    }
    const providerRequestId = evt.signatureRequestId ?? '';
    const event = this.mapEventType(evt.eventType);
    return { providerRequestId, event };
  }

  /** Map a HelloSign event_type → our normalized provider event. */
  private mapEventType(eventType: string): 'VIEWED' | 'SIGNED' | 'DECLINED' {
    switch (eventType) {
      case 'signature_request_viewed':
        return 'VIEWED';
      case 'signature_request_signed':
      case 'signature_request_all_signed':
        return 'SIGNED';
      case 'signature_request_declined':
        return 'DECLINED';
      default:
        // Any other event type is not a state-advancing event for us; the
        // controller treats an unmapped event as a no-op 200. We surface
        // it as VIEWED-equivalent only when explicitly mapped above, so we
        // throw here and let the controller catch + ack.
        throw new ServiceUnavailableException(
          `Unhandled HelloSign event_type: ${eventType}`,
        );
    }
  }

  /**
   * Normalize a HelloSign callback into the fields we need. HelloSign posts
   * a multipart form with a `json` field holding the event; the controller
   * parses it into `parsedBody`. We also tolerate a raw JSON body.
   */
  private extractEventObject(req: ProviderWebhookRequest): {
    eventTime: string;
    eventType: string;
    eventHash: string;
    signatureRequestId?: string;
  } | null {
    const root = this.resolveJson(req);
    if (!root || typeof root !== 'object') return null;
    const event = (root as Record<string, unknown>).event as
      | Record<string, unknown>
      | undefined;
    if (!event) return null;

    const eventTime = this.asString(event.event_time);
    const eventType = this.asString(event.event_type);
    const eventHash = this.asString(event.event_hash);

    const sigReq = (root as Record<string, unknown>).signature_request as
      | Record<string, unknown>
      | undefined;
    const metaSigReqId = (
      (event.event_metadata as Record<string, unknown> | undefined) ?? {}
    ).related_signature_id;

    const signatureRequestId =
      this.asString(sigReq?.signature_request_id) ||
      this.asString(metaSigReqId) ||
      undefined;

    return { eventTime, eventType, eventHash, signatureRequestId };
  }

  private resolveJson(req: ProviderWebhookRequest): unknown {
    if (req.parsedBody && typeof req.parsedBody === 'object') {
      return req.parsedBody;
    }
    try {
      return JSON.parse(req.rawBody.toString('utf8'));
    } catch {
      return null;
    }
  }

  private asString(v: unknown): string {
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    return '';
  }
}

// ─── Structural typing for the lazily-required @dropbox/sign SDK ──────────────
//
// We deliberately do NOT `import('@dropbox/sign')` for types: the package is a
// runtime/CI dependency (declared in package.json) but may be absent in some
// sandboxes. These minimal shapes describe only the surface this adapter
// touches; the real SDK is structurally compatible.
interface HelloSignApiResponseBody<T> {
  body?: T;
}
interface HelloSignSignature {
  signatureId?: string;
}
interface HelloSignSignatureRequest {
  signatureRequestId?: string;
  signatures?: HelloSignSignature[];
}
interface HelloSignSignatureRequestApi {
  username: string;
  signatureRequestCreateEmbedded(
    opts: Record<string, unknown>,
  ): Promise<HelloSignApiResponseBody<{ signatureRequest?: HelloSignSignatureRequest }>>;
  signatureRequestGet(
    id: string,
  ): Promise<HelloSignApiResponseBody<{ signatureRequest?: HelloSignSignatureRequest }>>;
  signatureRequestFiles(id: string, fileType: string): Promise<unknown>;
}
interface HelloSignEmbeddedApi {
  username: string;
  embeddedSignUrl(
    signatureId: string,
  ): Promise<HelloSignApiResponseBody<{ embedded?: { signUrl?: string } }>>;
}
interface HelloSignSdk {
  SignatureRequestApi: new () => HelloSignSignatureRequestApi;
  EmbeddedApi: new () => HelloSignEmbeddedApi;
}
