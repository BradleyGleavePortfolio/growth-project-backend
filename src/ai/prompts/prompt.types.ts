// Shared prompt-versioning types. Each capability file exports a single
// `*Prompt` object conforming to this shape; the registry in index.ts maps
// a (capability, version) tuple to the right entry.
import { ClientContext } from '../context/client-context.types';
import type { RuntimeValidator } from '../adapters/anthropic.adapter';

export interface CoachAIPrompt<Input, Output> {
  readonly name: string;
  readonly version: string;
  readonly system: string;
  buildUser(ctx: ClientContext, input: Input): string;
  validate: RuntimeValidator<Output>;
}
