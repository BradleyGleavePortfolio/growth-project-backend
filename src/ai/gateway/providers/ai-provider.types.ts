// Provider-adapter contract. Each adapter (stub, perplexity, openai,
// anthropic, …) implements this interface. The gateway picks one based
// on AiGatewayConfig.resolve() and never lets controllers/services hold
// a direct reference to a provider client.
//
// Inputs are intentionally narrow: a system message + a sequence of
// chat turns + the redaction-summary so the adapter can attach it to
// provider request metadata where the upstream supports it.

export interface AiChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiProviderRequest {
  capability: string;
  systemPrompt: string;
  turns: AiChatTurn[];
  maxTokens?: number;
  temperature?: number;
  // Stable id for idempotency / dedupe at the provider edge. Generated
  // by the gateway, not by the caller.
  requestId: string;
}

export interface AiProviderResponse {
  provider: string;
  model: string;
  text: string;
  // True when this came from a real upstream call. False for the stub
  // (disabled / fallback) path.
  enabled: boolean;
  promptTokenEstimate?: number;
  responseTokenEstimate?: number;
  // Surface any provider-side flags so the audit row can capture them
  // (e.g. content-policy hits, completion truncated, fallback reason).
  meta?: Record<string, unknown>;
}

export interface AiProviderAdapter {
  readonly name: string;
  complete(req: AiProviderRequest): Promise<AiProviderResponse>;
}
