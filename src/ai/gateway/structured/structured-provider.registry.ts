import { Inject, Injectable } from '@nestjs/common';
import { AiProviderName } from '../ai-gateway.config';
import { AiStructuredProviderAdapter } from './structured-provider.types';
import { StubStructuredProviderAdapter } from './stub-structured-provider.adapter';
import { AnthropicStructuredProviderAdapter } from './anthropic-structured-provider.adapter';
import { AiGatewayError } from './structured-ai.errors';

// L1-gw — structured-provider seam. Unlike `AiProviderRegistry.resolve`,
// an unwired provider name is NOT silently mapped to the stub: it returns
// `null`, and the gateway turns that into `ai_unavailable`. The stub is
// returned only when the caller explicitly asks for it (after
// ImporterMappingConfig has confirmed the stub is permitted).
@Injectable()
export class AiStructuredProviderRegistry {
  constructor(
    private readonly stub: StubStructuredProviderAdapter,
    // Injected by class token but held as the interface so tests can supply a
    // fake provider without a type assertion (no paid calls in tests).
    @Inject(AnthropicStructuredProviderAdapter)
    private readonly anthropic: AiStructuredProviderAdapter,
  ) {}

  resolveReal(name: AiProviderName): AiStructuredProviderAdapter | null {
    if (name === 'anthropic') return this.anthropic;
    // openai / perplexity have no structured adapter wired yet — fail
    // closed rather than degrade to a stub.
    return null;
  }

  resolveRealOrThrow(name: AiProviderName): AiStructuredProviderAdapter {
    const adapter = this.resolveReal(name);
    if (!adapter) {
      throw new AiGatewayError('ai_unavailable', {
        provider: name,
        model: null,
        reason: `provider-not-wired:${name}`,
      });
    }
    return adapter;
  }

  resolveStub(): AiStructuredProviderAdapter {
    return this.stub;
  }
}
