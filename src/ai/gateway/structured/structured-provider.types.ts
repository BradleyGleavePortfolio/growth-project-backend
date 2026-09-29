// L1-gw — structured (JSON-schema) provider contract.
//
// Unlike `AiProviderAdapter.complete` (free text, optional limits, no model
// override), a structured adapter MUST receive a JSON schema and MUST return
// an object the provider produced against that schema. Model, max output
// tokens, temperature and an abort signal are all mandatory so the gateway
// — not the adapter — owns every limit. Adapters never fall back to a stub
// and never swallow errors: they either return a response or throw an
// `AiGatewayError`.

export type JsonSchemaObject = {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean | Record<string, unknown>;
  // Any other draft-07 / 2020-12 keywords the caller wants forwarded.
  [k: string]: unknown;
};

export interface AiStructuredProviderRequest {
  capability: string;
  requestId: string;
  model: string;
  systemPrompt: string;
  // Already redacted by the gateway before it reaches an adapter.
  userContent: string;
  responseSchema: JsonSchemaObject;
  // Short identifier for the schema (used as the provider tool name where
  // the transport is tool-use). Letters/digits/underscore only.
  schemaName: string;
  maxOutputTokens: number;
  temperature: number;
  // Fires when the gateway's hard per-request timeout elapses. Adapters
  // must pass it to their HTTP client so the socket is actually closed.
  signal: AbortSignal;
  timeoutMs: number;
}

export interface AiStructuredProviderResponse {
  provider: string;
  // Model the provider reports it actually used.
  model: string;
  // Parsed JSON object as produced by the provider. The gateway validates
  // it against the caller's parser before returning anything.
  output: unknown;
  // False only for the stub adapter (test / explicit dev flag).
  enabled: boolean;
  promptTokens: number;
  responseTokens: number;
  latencyMs: number;
  // Provider-side stop reason, when known ("end_turn", "tool_use",
  // "max_tokens", ...). "max_tokens" is treated as malformed output.
  stopReason?: string | null;
}

export interface AiStructuredProviderAdapter {
  readonly name: string;
  completeStructured(req: AiStructuredProviderRequest): Promise<AiStructuredProviderResponse>;
}
