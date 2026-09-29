import { Injectable } from '@nestjs/common';
import {
  AiStructuredProviderAdapter,
  AiStructuredProviderRequest,
  AiStructuredProviderResponse,
} from './structured-provider.types';

// L1-gw — structured stub. Reached ONLY when ImporterMappingConfig says the
// stub is permitted (NODE_ENV=test, or AI_GATEWAY_DEV_ALLOW_OFFLINE_PROVIDER outside
// production). It deliberately returns `output: null` and `enabled: false`:
// a stub must never fabricate a mapping that could be parsed as a proposal.
// Callers treat `enabled === false` as "AI unavailable" (record D-L0-7.5).
@Injectable()
export class StubStructuredProviderAdapter implements AiStructuredProviderAdapter {
  readonly name = 'stub';

  async completeStructured(
    req: AiStructuredProviderRequest,
  ): Promise<AiStructuredProviderResponse> {
    return {
      provider: 'stub',
      model: 'disabled',
      output: null,
      enabled: false,
      promptTokens: estimateTokens(req.systemPrompt) + estimateTokens(req.userContent),
      responseTokens: 0,
      latencyMs: 0,
      stopReason: 'stub',
    };
  }
}

export function estimateTokens(s: string): number {
  if (!s) return 0;
  // ~4 chars/token — the same rough estimate the legacy stub uses.
  return Math.max(1, Math.round(s.length / 4));
}
