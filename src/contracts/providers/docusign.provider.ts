import { Injectable, NotImplementedException } from '@nestjs/common';
import {
  CreateSignatureRequestInput,
  CreateSignatureRequestResult,
  ParsedWebhookEvent,
  ProviderWebhookRequest,
  SignatureProvider,
} from './signature-provider.interface';

/**
 * B5 — DocuSign provider STUB (spec §2, §3.6, §8).
 *
 * Enterprise-tier upgrade path behind `FEATURE_CONTRACTS_DOCUSIGN_PROVIDER`
 * (default OFF). NOT wired in v1: every method throws
 * `NotImplementedException`. It exists now only so the provider abstraction
 * proves out as a cheap flag-flip rather than a rewrite (spec §11). When the
 * flag is flipped, this adapter is implemented against the DocuSign eSignature
 * API and bound in `contracts.module.ts` with precedence over the HelloSign
 * default. Until then it must never be reachable: the module binder only
 * selects it when the flag is ON, and these throws are the belt-and-braces
 * guarantee that an accidental binding fails loudly instead of silently.
 */
@Injectable()
export class DocuSignProvider implements SignatureProvider {
  readonly providerKey = 'docusign';

  private notImplemented(): never {
    throw new NotImplementedException({
      error: 'CONTRACTS_PROVIDER_NOT_IMPLEMENTED',
      message:
        'The DocuSign e-signature provider is not implemented in v1. ' +
        'It is a future enterprise-tier flag-flip (FEATURE_CONTRACTS_DOCUSIGN_PROVIDER).',
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
