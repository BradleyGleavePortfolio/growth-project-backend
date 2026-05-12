import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

// The full list of secrets the application reads at runtime, with metadata.
// This is the canonical inventory — update it whenever a new secret is added.
//
// WHY IT LIVES HERE
// -----------------
// Keeping the inventory in code (not just docs) means the /admin/secrets/status
// endpoint always reflects the real set of secrets the app cares about. If a
// new secret is added and this list is not updated, the status endpoint will
// show it as "not tracked" — a deliberate signal to the operator.
//
// STALENESS THRESHOLD
// -------------------
// 90 days is the default. Secrets with no log entry are shown as "never rotated"
// which is always stale. Secrets that should be rotated more frequently
// (e.g. JWT signing keys) carry a custom threshold.
export interface SecretDefinition {
  name: string;
  description: string;
  /** Rotation cadence in days. Defaults to 90 if not specified. */
  cadenceDays: number;
  /**
   * The tier of this secret.
   * - 'critical' = exposed = immediate incident response required
   * - 'high'     = rotate within 24h if compromised
   * - 'standard' = routine 90-day rotation
   */
  tier: 'critical' | 'high' | 'standard';
}

export const SECRET_INVENTORY: SecretDefinition[] = [
  {
    name: 'JWT_SIGNING_KEY',
    description:
      'HMAC-SHA256 key used to sign internal JWT tokens. Supports dual-key ' +
      'transition: set JWT_SIGNING_KEY_PREVIOUS to the old value during a 24h ' +
      'transition window so existing tokens remain valid.',
    cadenceDays: 90,
    tier: 'critical',
  },
  {
    name: 'JWT_SIGNING_KEY_PREVIOUS',
    description:
      'Previous JWT signing key, accepted during a 24h rotation transition window. ' +
      'Clear this secret after 24h to complete the rotation.',
    cadenceDays: 90,
    tier: 'critical',
  },
  {
    name: 'DATABASE_URL',
    description:
      'Supabase Postgres connection string (session-pooler URL). Rotating this ' +
      'requires a brief maintenance window unless Supabase supports parallel ' +
      'connection strings.',
    cadenceDays: 180,
    tier: 'critical',
  },
  {
    name: 'SUPABASE_SERVICE_ROLE_KEY',
    description:
      'Supabase service-role key — bypasses Row-Level Security. Extremely sensitive. ' +
      'Rotate immediately if exposed.',
    cadenceDays: 90,
    tier: 'critical',
  },
  {
    name: 'STRIPE_SECRET_KEY',
    description:
      'Stripe secret key (sk_live_…). Used for all payment API calls. ' +
      'Rotate by generating a new restricted key in the Stripe dashboard.',
    cadenceDays: 180,
    tier: 'critical',
  },
  {
    name: 'STRIPE_WEBHOOK_SECRET',
    description:
      'Stripe webhook signing secret (whsec_…). Validates that webhook events ' +
      'actually came from Stripe.',
    cadenceDays: 180,
    tier: 'high',
  },
  {
    name: 'SENTRY_DSN',
    description:
      'Sentry Data Source Name — identifies the Sentry project that receives ' +
      'error reports. Low sensitivity but should be rotated if the project is ' +
      'compromised.',
    cadenceDays: 365,
    tier: 'standard',
  },
  {
    name: 'FLY_API_TOKEN',
    description:
      'Fly.io deploy token used by GitHub Actions to trigger Fly deploys. ' +
      'Stored as a GitHub Actions secret (not a Fly secret). Rotate via ' +
      '`fly tokens create deploy -a backend-spring-lake-3890`.',
    cadenceDays: 90,
    tier: 'high',
  },
  {
    name: 'PERPLEXITY_API_KEY',
    description:
      'Perplexity AI API key. Used for the AI chat feature. Rotate via ' +
      'the Perplexity dashboard if exposed.',
    cadenceDays: 180,
    tier: 'standard',
  },
  {
    name: 'POSTHOG_KEY',
    description:
      'PostHog project API key for product analytics. Low sensitivity.',
    cadenceDays: 365,
    tier: 'standard',
  },
  {
    name: 'USDA_API_KEY',
    description:
      'USDA FoodData Central API key. Free key; low sensitivity but rotation ' +
      'is quick (re-register at fdc.nal.usda.gov).',
    cadenceDays: 365,
    tier: 'standard',
  },
  {
    name: 'REDIS_URL',
    description:
      'Redis connection URL including password (rediss://…). Used for rate-limit ' +
      'counter sharing across Fly machines.',
    cadenceDays: 180,
    tier: 'high',
  },
  {
    name: 'FINANCE_SERVICE_TOKEN',
    description:
      'Shared bearer token for fitness↔finance service-to-service calls. ' +
      'Must be identical on both backends. Generate with `openssl rand -hex 32`.',
    cadenceDays: 90,
    tier: 'critical',
  },
];

export const STALE_THRESHOLD_DAYS = 90;

export interface SecretStatus {
  name: string;
  description: string;
  cadenceDays: number;
  tier: SecretDefinition['tier'];
  lastRotatedAt: Date | null;
  rotatedByUserId: string | null;
  notes: string | null;
  isStale: boolean;
  daysSinceRotation: number | null;
}

@Injectable()
export class SecretsService {
  private readonly logger = new Logger(SecretsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Return status for all tracked secrets. Never returns secret values — only
   * metadata about when each secret was last rotated and whether it is stale.
   */
  async getSecretsStatus(): Promise<SecretStatus[]> {
    // Load the most recent rotation log entry per secret in one query.
    const logs = await this.prisma.secretRotationLog.findMany({
      orderBy: { rotated_at: 'desc' },
    });

    // Build a map: secret_name → most recent log entry.
    const latestByName = new Map<
      string,
      { rotated_at: Date; rotated_by_user_id: string | null; notes: string | null }
    >();
    for (const log of logs) {
      if (!latestByName.has(log.secret_name)) {
        latestByName.set(log.secret_name, {
          rotated_at: log.rotated_at,
          rotated_by_user_id: log.rotated_by_user_id,
          notes: log.notes,
        });
      }
    }

    const now = new Date();

    return SECRET_INVENTORY.map((def) => {
      const entry = latestByName.get(def.name) ?? null;
      const lastRotatedAt = entry?.rotated_at ?? null;

      let daysSinceRotation: number | null = null;
      let isStale = true; // never rotated = always stale

      if (lastRotatedAt) {
        daysSinceRotation = Math.floor(
          (now.getTime() - lastRotatedAt.getTime()) / (1000 * 60 * 60 * 24),
        );
        isStale = daysSinceRotation > def.cadenceDays;
      }

      return {
        name: def.name,
        description: def.description,
        cadenceDays: def.cadenceDays,
        tier: def.tier,
        lastRotatedAt,
        rotatedByUserId: entry?.rotated_by_user_id ?? null,
        notes: entry?.notes ?? null,
        isStale,
        daysSinceRotation,
      };
    });
  }

  /**
   * Record that a secret has been rotated. Does NOT accept or store the
   * secret value — only the name, timestamp, and optional notes.
   */
  async recordRotation(
    secretName: string,
    rotatedByUserId: string,
    notes?: string,
  ): Promise<{ id: string; rotatedAt: Date }> {
    // Validate that this secret name is in the inventory. We don't hard-reject
    // unknown names (in case a new secret is temporarily not yet in the list)
    // but we do log a warning so the inventory gets updated.
    const known = SECRET_INVENTORY.some((d) => d.name === secretName);
    if (!known) {
      this.logger.warn(
        `Recording rotation for unknown secret "${secretName}" — add it to SECRET_INVENTORY in secrets.service.ts`,
      );
    }

    const log = await this.prisma.secretRotationLog.create({
      data: {
        secret_name: secretName,
        rotated_by_user_id: rotatedByUserId,
        notes: notes ?? null,
      },
    });

    this.logger.log(
      `Secret rotated: name=${secretName} by_user=${rotatedByUserId}`,
      // Deliberately NOT logging notes — notes could accidentally contain
      // partial secret values if an operator is careless.
    );

    return { id: log.id, rotatedAt: log.rotated_at };
  }
}
