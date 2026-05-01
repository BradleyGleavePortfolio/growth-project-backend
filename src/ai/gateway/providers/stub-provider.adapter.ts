import { Injectable } from '@nestjs/common';
import { AiProviderAdapter, AiProviderRequest, AiProviderResponse } from './ai-provider.types';

// Deterministic stub used when:
//   - the gateway is disabled (AI_GATEWAY_ENABLED!=true)
//   - the resolved provider has no API key
//   - the capability is not in the allow-list
//
// Returns a clearly-marked "[ai-disabled]" body so callers can surface the
// state to the user instead of pretending a real model answered. Token
// estimates are approximated from input length so audit rows still carry
// useful magnitude info even when no provider call happened.
@Injectable()
export class StubProviderAdapter implements AiProviderAdapter {
  readonly name = 'stub';

  async complete(req: AiProviderRequest): Promise<AiProviderResponse> {
    const lastUser = [...req.turns].reverse().find((t) => t.role === 'user');
    const echoed = (lastUser?.content ?? '').slice(0, 240);
    const text =
      `[ai-disabled] AI gateway is in stub mode for capability "${req.capability}". ` +
      `No upstream provider was called. ` +
      (echoed ? `Echo of your message (truncated): ${echoed}` : 'No user message supplied.');
    return {
      provider: 'stub',
      model: 'disabled',
      text,
      enabled: false,
      promptTokenEstimate: estimateTokens(req.systemPrompt + req.turns.map((t) => t.content).join('\n')),
      responseTokenEstimate: estimateTokens(text),
      meta: { reason: 'stub-provider' },
    };
  }
}

function estimateTokens(s: string): number {
  if (!s) return 0;
  // ~4 chars/token is the standard rough estimate for English-language prose.
  return Math.max(1, Math.round(s.length / 4));
}
