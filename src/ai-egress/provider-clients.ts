/**
 * R2b — the only place AI provider SDK clients are constructed.
 *
 * The factories return opaque handles, never the SDK client: the client is
 * reachable only from AiEgressService, which checks the live box-2 grant
 * before every request and owns retries (C-626-1, A-626-1; the photo check's
 * moderation send is the one ungated send; openAiModerationCreate says why).
 * SDK auto-retry is off here (`maxRetries: 0`) and forced off again on every
 * request.
 *
 * ESLint (no-restricted-imports in eslint.config.js) and the static guard in
 * test/ai-egress/ai-egress-guard.spec.ts allow AI SDK value imports,
 * `new Anthropic(` / `new OpenAI(`, provider method calls and provider host
 * names only inside src/ai-egress/.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { AnthropicHandle, OpenAiModerationHandle, PerplexityHandle } from './ai-egress.service';

export const PERPLEXITY_BASE_URL = 'https://api.perplexity.ai';
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** Transport injection for tests (in-memory HTTP). No key, retry or URL override. */
export interface ProviderClientOptions {
  fetch?: typeof fetch;
}

export function createAnthropicClient(
  apiKey: string,
  opts: ProviderClientOptions = {},
): AnthropicHandle {
  return AnthropicHandle.bind(
    new Anthropic({ apiKey, maxRetries: 0, ...(opts.fetch ? { fetch: opts.fetch } : {}) }),
  );
}

export function createPerplexityClient(
  apiKey: string,
  opts: ProviderClientOptions = {},
): PerplexityHandle {
  return PerplexityHandle.bind(
    new OpenAI({
      apiKey,
      baseURL: PERPLEXITY_BASE_URL,
      maxRetries: 0,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    }),
  );
}

/**
 * PHOTO-CHECK-BE: OpenAI's moderation endpoint (the automatic photo check).
 * Host, organisation, project and log level are pinned, so the SDK's OPENAI_*
 * env fallbacks can never redirect a photo, bill it elsewhere or log it.
 */
export function createOpenAiModerationClient(
  apiKey: string,
  opts: ProviderClientOptions = {},
): OpenAiModerationHandle {
  return OpenAiModerationHandle.bind(
    new OpenAI({
      apiKey,
      baseURL: OPENAI_BASE_URL,
      organization: null,
      project: null,
      logLevel: 'off',
      maxRetries: 0,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    }),
  );
}
