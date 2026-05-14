import { Injectable, Logger } from '@nestjs/common';
import { AnthropicAdapter } from '../../adapters/anthropic.adapter';
import { CoachAIStateService } from '../../coach/coach-ai-state.service';
import { COACH_AI_MODEL } from '../../coach/coach-ai.constants';
import {
  AiProviderAdapter,
  AiProviderRequest,
  AiProviderResponse,
} from './ai-provider.types';

// Gateway-side adapter that delegates to the Coach AI v1 AnthropicAdapter.
// The gateway already enforces tenancy / redaction / approval; this
// adapter is the thin shim that turns the gateway's chat-style request
// shape into our `complete(system, user)` signature.
@Injectable()
export class AnthropicProviderAdapter implements AiProviderAdapter {
  readonly name = 'anthropic';
  private readonly logger = new Logger(AnthropicProviderAdapter.name);

  constructor(
    private readonly anthropic: AnthropicAdapter,
    private readonly state: CoachAIStateService,
  ) {}

  async complete(req: AiProviderRequest): Promise<AiProviderResponse> {
    if (!this.state.isReady()) {
      // Engine off — return a deterministic disabled-mode payload so the
      // gateway audit row records `enabled=false` and the caller's UI
      // surfaces the same "[ai-disabled]" semantics as the stub path.
      return {
        provider: 'anthropic',
        model: COACH_AI_MODEL,
        text: '[ai-disabled] ANTHROPIC_API_KEY not configured',
        enabled: false,
        meta: { reason: 'coach_ai_not_ready' },
      };
    }
    // Fold all non-system turns into a single user message for the
    // adapter (Sonnet handles multi-turn but the gateway's existing
    // shape concatenates history into the prompt prior to retrieval).
    const userText = req.turns
      .filter((t) => t.role !== 'system')
      .map((t) => (t.role === 'assistant' ? `Assistant: ${t.content}` : `User: ${t.content}`))
      .join('\n');
    const result = await this.anthropic.complete(
      { system: req.systemPrompt, user: userText },
      {
        maxTokens: req.maxTokens,
        temperature: req.temperature,
        capability: req.capability || 'gateway',
      },
    );
    return {
      provider: 'anthropic',
      model: result.modelUsed,
      text: result.text,
      enabled: true,
      promptTokenEstimate: result.tokensIn,
      responseTokenEstimate: result.tokensOut,
      meta: { latencyMs: result.latencyMs },
    };
  }
}
