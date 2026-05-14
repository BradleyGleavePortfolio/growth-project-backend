import { Injectable, Logger } from '@nestjs/common';
import { AiProviderAdapter } from './ai-provider.types';
import { StubProviderAdapter } from './stub-provider.adapter';
import { AnthropicProviderAdapter } from './anthropic-provider.adapter';
import { AiProviderName } from '../ai-gateway.config';

// Single seam where provider adapters get wired in. As of Coach AI v1
// the `anthropic` slot is real (Claude Sonnet via the AnthropicAdapter);
// `openai` and `perplexity` are still stubs and will surface a warning
// in logs so ops can see the gap if AI_GATEWAY_PROVIDER is set to a
// not-yet-implemented name. The gateway has already fail-closed in
// AiGatewayConfig if provider keys are missing.
@Injectable()
export class AiProviderRegistry {
  private readonly logger = new Logger(AiProviderRegistry.name);

  constructor(
    private readonly stub: StubProviderAdapter,
    private readonly anthropicAdapter: AnthropicProviderAdapter,
  ) {}

  resolve(name: AiProviderName): AiProviderAdapter {
    if (name === 'stub') return this.stub;
    if (name === 'anthropic') return this.anthropicAdapter;
    // openai / perplexity intentionally still stubbed — Coach AI v1 only
    // wires the Claude Sonnet adapter. Logging at warn level so ops can
    // see the gap if AI_GATEWAY_PROVIDER points at an unwired provider.
    this.logger.warn(`No adapter registered for provider "${name}"; using stub.`);
    return this.stub;
  }
}
