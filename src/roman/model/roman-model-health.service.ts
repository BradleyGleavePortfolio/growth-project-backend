/**
 * RomanModelHealthService — boot probe + runtime health for Roman's models
 * (PLAN_roman_intelligence §3 "Startup and health check", slice R1).
 *
 * Pattern copied (not shared) from `CoachAIStateService`: on boot, send a
 * tiny "ping" probe (budget per model profile) to the PRIMARY and the
 * FALLBACK model, using exactly the per-model request profile the turn path
 * sends. States:
 *
 *   ready         primary answered (fallback may or may not have)
 *   degraded      only the fallback answered → logged at error + Sentry
 *   down          neither answered → logged at error + Sentry; every Roman
 *                 send returns 503 ROMAN_UNAVAILABLE with an error frame
 *   unconfigured  no ANTHROPIC_API_KEY / no client → Roman unavailable
 *   unprobed      before the first probe finished (treated as "try anyway")
 *
 * If FEATURE_ROMAN_CHAT_ENABLED=true in production and BOTH probes fail, boot
 * logs `FATAL [roman] model unavailable` and `/health/roman` returns 503 so a
 * deploy smoke can catch it.
 *
 * Re-probed every 15 minutes, and on 3 consecutive upstream not_found / 404
 * errors reported by the service at runtime. NODE_ENV=test skips the network
 * (the same seam the coach-AI probe uses) so unit tests stay hermetic.
 *
 * Logging rule (plan §6.5): never log upstream response text. Only the error
 * class, HTTP status and Anthropic error `type` are recorded.
 */

import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';
import type Anthropic from '@anthropic-ai/sdk';
import { ROMAN_ANTHROPIC_CLIENT } from '../anthropic-client.provider';
import { isRomanChatEnabled } from '../roman.feature';
import {
  RomanModelConfig,
  RomanModelProfile,
  probeRequestFor,
  resolveRomanModelConfig,
} from './roman-model.config';
import { describeUpstreamError } from './roman-upstream-error';

export type RomanModelHealthState = 'ready' | 'degraded' | 'down' | 'unconfigured' | 'unprobed';

export interface RomanModelHealthStatus {
  status: RomanModelHealthState;
  primary_model: string;
  fallback_model: string;
  primary_ok: boolean | null;
  fallback_ok: boolean | null;
  probed_at: string | null;
  /** Short machine-safe reason (never upstream text). */
  reason?: string;
}

/** DI token for a test-only env override; no production provider binds it. */
export const ROMAN_ENV_OVERRIDE = 'ROMAN_ENV_OVERRIDE';
export const ROMAN_HEALTH_REPROBE_MS = 15 * 60 * 1000;
export const ROMAN_HEALTH_NOT_FOUND_THRESHOLD = 3;
/**
 * Probe budget comes from the model profile (`probeMaxTokens`): 4 tokens for
 * text-only families, more for always-adaptive Opus so thinking + "pong" fit.
 */
const PROBE_TIMEOUT_MS = 15_000;

@Injectable()
export class RomanModelHealthService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('roman');
  readonly config: RomanModelConfig;
  private status: RomanModelHealthStatus;
  private timer: NodeJS.Timeout | null = null;
  private consecutiveNotFound = 0;
  private probing: Promise<void> | null = null;

  constructor(
    @Optional()
    @Inject(ROMAN_ANTHROPIC_CLIENT)
    private readonly anthropic: Anthropic | null = null,
    /** Test seam: override env without touching process.env (never bound in prod). */
    @Optional()
    @Inject(ROMAN_ENV_OVERRIDE)
    env: NodeJS.ProcessEnv | null = null,
  ) {
    env ??= process.env;
    // Throws RomanModelConfigError on an unknown / retired id → boot fails loudly.
    this.config = resolveRomanModelConfig(env);
    this.status = {
      status: this.anthropic ? 'unprobed' : 'unconfigured',
      primary_model: this.config.primary.id,
      fallback_model: this.config.fallback.id,
      primary_ok: null,
      fallback_ok: null,
      probed_at: null,
      reason: this.anthropic ? undefined : 'ANTHROPIC_API_KEY not set',
    };
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.anthropic) {
      this.logger.warn('[roman] model unconfigured — set ANTHROPIC_API_KEY in Fly secrets');
      return;
    }
    if (process.env.NODE_ENV === 'test') {
      this.status = {
        ...this.status,
        status: 'ready',
        primary_ok: true,
        fallback_ok: true,
        probed_at: new Date().toISOString(),
        reason: 'test mode — skipped live probe',
      };
      return;
    }
    await this.probe();
    this.timer = setInterval(() => {
      void this.probe();
    }, ROMAN_HEALTH_REPROBE_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Current status snapshot (no PII, safe for /health/roman). */
  getStatus(): RomanModelHealthStatus {
    return { ...this.status };
  }

  /** True when every send must short-circuit to 503 ROMAN_UNAVAILABLE. */
  isDown(): boolean {
    return this.status.status === 'down' || this.status.status === 'unconfigured';
  }

  /**
   * Which model to try first this turn. If the last probe showed the primary
   * failing but the fallback answering, go straight to the fallback so the
   * user does not pay the failed-primary latency on every turn.
   */
  preferredOrder(): RomanModelProfile[] {
    const { primary, fallback } = this.config;
    if (this.status.primary_ok === false && this.status.fallback_ok === true) {
      return [fallback];
    }
    return primary.id === fallback.id ? [primary] : [primary, fallback];
  }

  /**
   * Runtime signal from the service: an upstream 404 / not_found_error. Three
   * in a row trigger an immediate re-probe (a model can be retired between
   * deploys). Any success resets the counter.
   */
  noteUpstreamNotFound(): void {
    this.consecutiveNotFound += 1;
    if (this.consecutiveNotFound >= ROMAN_HEALTH_NOT_FOUND_THRESHOLD) {
      this.consecutiveNotFound = 0;
      if (process.env.NODE_ENV !== 'test') void this.probe();
    }
  }

  noteUpstreamSuccess(): void {
    this.consecutiveNotFound = 0;
  }

  /** Probe both models. Serialised so overlapping triggers share one run. */
  probe(): Promise<void> {
    if (this.probing) return this.probing;
    this.probing = this.runProbe().finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  private async runProbe(): Promise<void> {
    if (!this.anthropic) return;
    const { primary, fallback, effort } = this.config;
    const [primaryOk, fallbackOk] = await Promise.all([
      this.probeOne(primary),
      primary.id === fallback.id ? Promise.resolve(null) : this.probeOne(fallback),
    ]);
    const effectiveFallbackOk = fallbackOk === null ? primaryOk : fallbackOk;
    const probed_at = new Date().toISOString();

    let status: RomanModelHealthState;
    if (primaryOk) status = 'ready';
    else if (effectiveFallbackOk) status = 'degraded';
    else status = 'down';

    this.status = {
      status,
      primary_model: primary.id,
      fallback_model: fallback.id,
      primary_ok: primaryOk,
      fallback_ok: effectiveFallbackOk,
      probed_at,
      reason:
        status === 'ready'
          ? undefined
          : status === 'degraded'
            ? 'primary_probe_failed'
            : 'all_probes_failed',
    };

    if (status === 'ready') {
      this.logger.log(
        `[roman] ready (primary=${primary.id}, fallback=${fallback.id}, effort=${effort})`,
      );
      return;
    }
    if (status === 'degraded') {
      this.logger.error(
        `[roman] degraded — primary ${primary.id} failed its probe; serving from fallback ${fallback.id}`,
      );
      Sentry.captureMessage('[roman] model degraded: primary probe failed', {
        level: 'error',
        tags: { primary_model: primary.id, fallback_model: fallback.id },
      });
      return;
    }
    const fatal = process.env.NODE_ENV === 'production' && isRomanChatEnabled();
    this.logger.error(
      `${fatal ? 'FATAL ' : ''}[roman] model unavailable — both ${primary.id} and ${fallback.id} failed their probes`,
    );
    Sentry.captureMessage('[roman] model unavailable: all probes failed', {
      level: 'error',
      tags: { primary_model: primary.id, fallback_model: fallback.id, fatal: String(fatal) },
    });
  }

  private async probeOne(profile: RomanModelProfile): Promise<boolean> {
    if (!this.anthropic) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      await this.anthropic.messages.create(
        {
          ...probeRequestFor(profile, this.config.effort),
          messages: [{ role: 'user', content: 'ping' }],
        } as Anthropic.MessageCreateParamsNonStreaming,
        { signal: controller.signal },
      );
      return true;
    } catch (err) {
      const d = describeUpstreamError(err);
      this.logger.warn(
        `[roman] probe failed model=${profile.id} class=${d.name} status=${d.status ?? '-'} type=${d.type ?? '-'}`,
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
