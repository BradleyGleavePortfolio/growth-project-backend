import { Injectable, NotImplementedException } from '@nestjs/common';
import {
  CreateSignatureRequestInput,
  CreateSignatureRequestResult,
  ParsedWebhookEvent,
  ProviderWebhookRequest,
  SignatureProvider,
} from './signature-provider.interface';

/**
 * B5 — Native-canvas provider STUB (spec §2, §3.6, §8).
 *
 * Future cost-reduction path behind `FEATURE_CONTRACTS_NATIVE_CANVAS`
 * (default OFF). NOT wired in v1: every method throws
 * `NotImplementedException`. When implemented it will render the contract,
 * capture a canvas signature image, server-generate the signed PDF, and
 * build the court-admissible audit trail itself (the spec is explicit that
 * under this path the audit trail is OURS to produce in a dispute — spec §1,
 * §6.1, §7). That weaker (US-only, self-built) legal posture is a deliberate
 * cost/control tradeoff, NOT the default. Shipping it as a stub now keeps the
 * provider abstraction honest (spec §11).
 */
@Injectable()
export class NativeCanvasProvider implements SignatureProvider {
  readonly providerKey = 'native_canvas';

  private notImplemented(): never {
    throw new NotImplementedException({
      error: 'CONTRACTS_PROVIDER_NOT_IMPLEMENTED',
      message:
        'The native-canvas e-signature provider is not implemented in v1. ' +
        'It is a future cost-reduction flag-flip (FEATURE_CONTRACTS_NATIVE_CANVAS).',
    });
  }

  createSignatureRequest(
    _input: CreateSignatureRequestInput,
  ): Promise<CreateSignatureRequestResult> {
    return this.notImplemented();
  }

  fetchSignedPdf(
    _providerRequestId: string,
  ): Promise<{ pdfBuffer: Buffer }> {
    return this.notImplemented();
  }

  verifyWebhook(_req: ProviderWebhookRequest): boolean {
    return this.notImplemented();
  }

  parseWebhookEvent(_req: ProviderWebhookRequest): ParsedWebhookEvent {
    return this.notImplemented();
  }

  refreshEmbedUrl(_providerRequestId: string): Promise<{ embedUrl: string }> {
    return this.notImplemented();
  }
}
