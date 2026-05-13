import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { COACH_AI_MODEL, COACH_AI_CAPABILITIES } from './coach-ai.constants';
import { ANTHROPIC_CLIENT_TOKEN } from '../adapters/anthropic.adapter';

// Coach AI module state. On boot, if ANTHROPIC_API_KEY is present, run a
// tiny live probe (4-token max_tokens) against the configured Sonnet
// model. If the probe succeeds → ready=true. If the key is missing or the
// probe fails → ready=false and the engine logs `[coach-ai] disabled —
// set ANTHROPIC_API_KEY` (or the failure reason).
//
// Tests (NODE_ENV=test) skip the live probe — we trust the env var
// presence/absence so unit tests don't make outbound network calls.
//
// Every coach-AI route asks isReady() before executing; if not ready,
// the controller throws 503 with a structured `{ error: "ai_disabled",
// action: "set ANTHROPIC_API_KEY in Fly secrets" }` body.

export interface CoachAIStatus {
  ready: boolean;
  reason?: string;
  modelUsed?: string;
  probedAt?: Date;
}

@Injectable()
export class CoachAIStateService implements OnApplicationBootstrap {
  private readonly logger = new Logger('coach-ai');
  private status: CoachAIStatus = { ready: false };

  constructor(
    private readonly config: ConfigService,
    @Optional() @Inject(ANTHROPIC_CLIENT_TOKEN) private readonly injectedClient?: Anthropic,
  ) {}

  // Called once by Nest after every module's onModuleInit. We do the
  // probe here so a deploy that ships the env var actually exercises the
  // SDK before serving a request, surfacing 401s in boot logs rather
  // than the first coach interaction.
  async onApplicationBootstrap(): Promise<void> {
    const apiKey =
      this.config.get<string>('ANTHROPIC_API_KEY') ?? process.env.ANTHROPIC_API_KEY ?? '';
    if (!apiKey.trim()) {
      this.status = { ready: false, reason: 'ANTHROPIC_API_KEY not set' };
      this.logger.warn('[coach-ai] disabled — set ANTHROPIC_API_KEY in Fly secrets');
      return;
    }

    if (process.env.NODE_ENV === 'test') {
      // Trust the env var; skip the network probe so unit tests are
      // hermetic. The adapter still uses the real key path at call time.
      this.status = {
        ready: true,
        modelUsed: COACH_AI_MODEL,
        probedAt: new Date(),
        reason: 'test mode — skipped live probe',
      };
      return;
    }

    try {
      const client = this.injectedClient ?? new Anthropic({ apiKey });
      await client.messages.create({
        model: COACH_AI_MODEL,
        max_tokens: 4,
        messages: [{ role: 'user', content: 'ping' }],
      });
      this.status = {
        ready: true,
        modelUsed: COACH_AI_MODEL,
        probedAt: new Date(),
      };
      this.logger.log(`[coach-ai] ready (model=${COACH_AI_MODEL})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.status = {
        ready: false,
        reason: `probe failed: ${msg}`,
        probedAt: new Date(),
      };
      this.logger.warn(
        `[coach-ai] disabled — set ANTHROPIC_API_KEY (probe failed: ${msg})`,
      );
    }
  }

  isReady(): boolean {
    return this.status.ready;
  }

  getStatus(): CoachAIStatus {
    return { ...this.status };
  }

  // Test seam — used by the boot-probe spec to assert the state machine
  // without invoking onApplicationBootstrap().
  setStatusForTesting(s: CoachAIStatus): void {
    this.status = s;
  }
}

// Re-exported so consumers can drop a literal `capability` without
// pulling in the constants module separately.
export { COACH_AI_CAPABILITIES };
