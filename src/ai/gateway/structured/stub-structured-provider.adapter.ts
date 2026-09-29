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
    _req: AiStructuredProviderRequest,
  ): Promise<AiStructuredProviderResponse> {
    return {
      provider: 'stub',
      model: 'disabled',
      output: null,
      enabled: false,
      // The stub spends nothing and reports no usage (unknown by construction;
      // the stub path never reserves, so nothing is charged either way).
      usage: null,
      latencyMs: 0,
      stopReason: 'stub',
    };
  }
}
