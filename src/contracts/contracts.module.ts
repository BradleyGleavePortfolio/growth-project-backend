import { Logger, Module, Provider } from '@nestjs/common';
import { ContractTemplateService } from './contract-template.service';
import { ContractEnvelopeService } from './contract-envelope.service';
import { ContractEnvelopeController } from './contract-envelope.controller';
import { HelloSignWebhookController } from './webhooks/hellosign-webhook.controller';
import { CheckoutContractGate } from './checkout-contract-gate.service';
import { ContractsTelemetry } from './contracts.telemetry';
import { SignedPdfStore } from './signed-pdf-store.service';
import { SIGNATURE_PROVIDER } from './providers/signature-provider.interface';
import { HelloSignProvider } from './providers/hellosign.provider';
import { DocuSignProvider } from './providers/docusign.provider';
import { NativeCanvasProvider } from './providers/native-canvas.provider';
import {
  isDocuSignProviderEnabled,
  isNativeCanvasProviderEnabled,
} from './contracts.feature';

/**
 * B5 — ContractsModule (spec §3.1).
 *
 * Wires the digital-contracts feature. PrismaService and AnalyticsService are
 * provided by their respective @Global modules, so this module declares only
 * the contracts-local providers + controllers.
 *
 * Provider precedence (spec §3.6): exactly one SignatureProvider is bound to
 * the SIGNATURE_PROVIDER token at boot, chosen by feature flag with a clear
 * order — native-canvas > docusign > hellosign-default. The two future
 * providers are NotImplemented stubs in v1, so binding them is gated strictly
 * behind their (default-OFF) flags; absent those flags HelloSign is always the
 * active provider.
 *
 * CheckoutContractGate + ContractEnvelopeService are exported so CheckoutModule
 * can enforce the two-layer gate before any Stripe call.
 */
const signatureProviderBinding: Provider = {
  provide: SIGNATURE_PROVIDER,
  inject: [HelloSignProvider, DocuSignProvider, NativeCanvasProvider],
  useFactory: (
    hellosign: HelloSignProvider,
    docusign: DocuSignProvider,
    nativeCanvas: NativeCanvasProvider,
  ) => {
    const logger = new Logger('ContractsModule');
    // native-canvas > docusign > hellosign-default.
    if (isNativeCanvasProviderEnabled()) {
      logger.warn(
        'FEATURE_CONTRACTS_NATIVE_CANVAS is ON — binding the native-canvas provider (STUB in v1).',
      );
      return nativeCanvas;
    }
    if (isDocuSignProviderEnabled()) {
      logger.warn(
        'FEATURE_CONTRACTS_DOCUSIGN_PROVIDER is ON — binding the DocuSign provider (STUB in v1).',
      );
      return docusign;
    }
    return hellosign;
  },
};

@Module({
  controllers: [ContractEnvelopeController, HelloSignWebhookController],
  providers: [
    ContractTemplateService,
    ContractEnvelopeService,
    CheckoutContractGate,
    ContractsTelemetry,
    SignedPdfStore,
    HelloSignProvider,
    DocuSignProvider,
    NativeCanvasProvider,
    signatureProviderBinding,
  ],
  exports: [
    ContractTemplateService,
    ContractEnvelopeService,
    CheckoutContractGate,
  ],
})
export class ContractsModule {}
