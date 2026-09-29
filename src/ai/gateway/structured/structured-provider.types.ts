// L1-gw — structured (JSON-schema) provider contract.
//
// Unlike `AiProviderAdapter.complete` (free text, optional limits, no model
// override), a structured adapter MUST receive a JSON schema and MUST return
// an object the provider produced against that schema. Model, max output
// tokens, temperature and an abort signal are all mandatory so the gateway
// — not the adapter — owns every limit. Adapters never fall back to a stub
// and never swallow errors: they either return a response or throw an
// `AiGatewayError`.

// A caller-owned JSON schema. Accepted READONLY and structurally loose so a
// consumer's own closed schema type (e.g. a readonly discriminated union with
// `readonly required?: readonly string[]`) is assignable without a cast; the
// gateway checks `type === 'object'` at runtime.
export type JsonSchemaObject = Readonly<Record<string, unknown>>;

export function isObjectSchema(s: unknown): s is JsonSchemaObject & { readonly type: 'object' } {
  return (
    !!s && typeof s === 'object' && !Array.isArray(s) && (s as { type?: unknown }).type === 'object'
  );
}

// Result shape of the caller's validator. Validators never throw; a failure
// carries JSON-pointer paths and fixed detail strings (no content).
export type StructuredValidation<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly errors: readonly { readonly path: string; readonly detail: string }[];
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
