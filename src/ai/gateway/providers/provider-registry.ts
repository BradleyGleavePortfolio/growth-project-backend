import { Injectable, Logger } from '@nestjs/common';
import { AiProviderAdapter } from './ai-provider.types';
import { StubProviderAdapter } from './stub-provider.adapter';
import { AiProviderName } from '../ai-gateway.config';

// Single seam where future provider adapters (perplexity, openai,
// anthropic) get wired in. Until those are implemented, the registry
// returns the stub for any non-stub name. The gateway has already
// fail-closed in AiGatewayConfig if the provider keys are missing, so
// reaching this fallback at runtime means a real adapter has not yet
// been registered for an enabled provider.
@Injectable()
export class AiProviderRegistry {
  private readonly logger = new Logger(AiProviderRegistry.name);

  constructor(private readonly stub: StubProviderAdapter) {}

  resolve(name: AiProviderName): AiProviderAdapter {
    if (name === 'stub') return this.stub;
    // Real adapters will be registered here behind their own keys; until
    // they exist the safe fallback is the stub. Logging at warn level so
    // ops can see the gap if AI_GATEWAY_PROVIDER is set without a
    // matching adapter being deployed.
    this.logger.warn(`No adapter registered for provider "${name}"; using stub.`);
    return this.stub;
  }
}
