/**
 * R2b — the only place AI provider SDK clients are constructed.
 *
 * Call sites hold the client (or a test fake bound to their DI token) but may
 * only use it through AiEgressService, which checks the data subject before
 * every request. The static guard in test/ai-egress/ai-egress-guard.spec.ts
 * allows AI SDK value imports, `new Anthropic(` / `new OpenAI(`, provider
 * method calls and provider host names only inside src/ai-egress/.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export const PERPLEXITY_BASE_URL = 'https://api.perplexity.ai';

export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

export function createPerplexityClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey, baseURL: PERPLEXITY_BASE_URL });
}
