/**
 * B5 — `SignatureProvider` abstraction (spec §3.6).
 *
 * Provider-agnostic by construction: the envelope state machine, controllers,
 * Prisma models, checkout integration and audit log do NOT know which
 * provider is bound. Only the adapter that implements this interface changes
 * between paths (HelloSign v1 default; DocuSign / native-canvas are future
 * flag-flips, shipped here as NotImplemented stubs). This is what makes the
 * future providers cheap flag-flips rather than rewrites (spec §11).
 *
 * The DI token below is bound in `contracts.module.ts` with a clear
 * precedence (native-canvas > docusign > hellosign-default) so exactly one
 * adapter is active at runtime.
 */

/** Minimal raw-request shape a provider needs for webhook verification. */
export interface ProviderWebhookRequest {
  /** The EXACT bytes the provider signed (Nest `req.rawBody`). */
  rawBody: Buffer;
  /** Lower-cased header map (express normalizes header names to lowercase). */
  headers: Record<string, string | string[] | undefined>;
  /**
   * Parsed body, when the provider transmits the signed payload as a form
   * field rather than the raw JSON body (HelloSign posts a multipart form
   * with a `json` field). Optional; verification is always byte-exact off
   * `rawBody` where possible.
   */
  parsedBody?: unknown;
}

export type ProviderEventKind = 'VIEWED' | 'SIGNED' | 'DECLINED';

export interface CreateSignatureRequestInput {
  /** Our envelope id — round-tripped so the webhook can resolve the row. */
  envelopeId: string;
  /** Merge-field-resolved contract body (HTML). */
  renderedHtml: string;
  client: { email: string; name: string };
  coach: { email: string; name: string };
  /** Title shown in the provider UI / on the signed PDF. */
  title: string;
  expiresAt: Date;
}

export interface CreateSignatureRequestResult {
  /** Generic provider request id (stored on `hellosign_request_id`). */
  providerRequestId: string;
  /** Short-lived embedded signing URL minted fresh per request. */
  embedUrl: string;
}

export interface ParsedWebhookEvent {
  providerRequestId: string;
  event: ProviderEventKind;
}

export interface SignatureProvider {
  /** Stable provider key for telemetry / audit (`hellosign` | `docusign` | `native_canvas`). */
  readonly providerKey: string;

  createSignatureRequest(
    input: CreateSignatureRequestInput,
  ): Promise<CreateSignatureRequestResult>;

  fetchSignedPdf(
    providerRequestId: string,
  ): Promise<{ pdfBuffer: Buffer }>;

  /** Mandatory signature verification. MUST return false on any mismatch. */
  verifyWebhook(req: ProviderWebhookRequest): boolean;

  /** Parse a VERIFIED webhook into a provider-request id + normalized event. */
  parseWebhookEvent(req: ProviderWebhookRequest): ParsedWebhookEvent;

  /**
   * Mint a fresh short-lived embed URL for an existing request (client
   * re-opens the signing surface). Separated from create so the client
   * `GET /contracts/envelopes/:id` endpoint can refresh the URL without
   * re-creating the provider request (spec §3.5).
   */
  refreshEmbedUrl(providerRequestId: string): Promise<{ embedUrl: string }>;
}

/** Nest DI token for the bound `SignatureProvider`. */
export const SIGNATURE_PROVIDER = Symbol('SIGNATURE_PROVIDER');
