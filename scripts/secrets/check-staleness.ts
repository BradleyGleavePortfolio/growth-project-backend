#!/usr/bin/env ts-node
/**
 * scripts/secrets/check-staleness.ts
 *
 * Checks whether any tracked secrets are overdue for rotation based on
 * the rotation log stored in the database.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." npx ts-node scripts/secrets/check-staleness.ts
 *
 * Exit codes:
 *   0 — all secrets are within their rotation cadence
 *   1 — one or more secrets are stale (overdue for rotation)
 *
 * In CI, run with: npx ts-node scripts/secrets/check-staleness.ts || true
 * (the || true prevents CI from failing on a stale secret — it's advisory only)
 *
 * WHAT THIS SCRIPT DOES (and does NOT do)
 * ----------------------------------------
 * - DOES: query the secret_rotation_log table for the most recent rotation per secret
 * - DOES: print a human-readable report showing days since rotation and recommended action
 * - DOES NOT: read secret values — only rotation log metadata
 * - DOES NOT: automatically rotate anything
 */

import { PrismaClient } from '@prisma/client';
import { SECRET_INVENTORY, STALE_THRESHOLD_DAYS } from '../../src/secrets/secrets.service';

// ─── Formatting helpers ───────────────────────────────────────────────────────

function padRight(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function formatDays(days: number | null): string {
  if (days === null) return 'never rotated';
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

function tierEmoji(tier: string): string {
  switch (tier) {
    case 'critical': return '🔴';
    case 'high':     return '🟠';
    default:         return '🟡';
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    log: [], // Silent — this is an operator script, not a service
  });

  try {
    console.log('\n=== Secrets Staleness Check ===\n');
    console.log(`Checking ${SECRET_INVENTORY.length} tracked secrets...\n`);

    // Load all log entries, most recent first.
    const logs = await prisma.secretRotationLog.findMany({
      orderBy: { rotated_at: 'desc' },
    });

    // Build latest-rotation map: secret_name → rotated_at
    const latestByName = new Map<string, Date>();
    for (const log of logs) {
      if (!latestByName.has(log.secret_name)) {
        latestByName.set(log.secret_name, log.rotated_at);
      }
    }

    const now = new Date();
    const staleSecrets: typeof SECRET_INVENTORY = [];

    // ── Report table ──────────────────────────────────────────────────────────
    console.log(
      `${padRight('SECRET', 40)} ${padRight('LAST ROTATED', 20)} ${padRight('DAYS SINCE', 12)} STATUS`,
    );
    console.log('─'.repeat(100));

    for (const def of SECRET_INVENTORY) {
      const lastRotated = latestByName.get(def.name) ?? null;
      let daysSince: number | null = null;
      let isStale = true;

      if (lastRotated) {
        daysSince = Math.floor(
          (now.getTime() - lastRotated.getTime()) / (1000 * 60 * 60 * 24),
        );
        isStale = daysSince > def.cadenceDays;
      }

      if (isStale) staleSecrets.push(def);

      const lastRotatedStr = lastRotated
        ? lastRotated.toISOString().slice(0, 10)
        : 'never';

      const daysSinceStr = formatDays(daysSince);

      let statusStr: string;
      if (daysSince === null) {
        statusStr = `${tierEmoji(def.tier)} NEVER ROTATED — rotate now (cadence: ${def.cadenceDays}d)`;
      } else if (isStale) {
        const overdue = daysSince - def.cadenceDays;
        statusStr = `${tierEmoji(def.tier)} STALE — ${overdue} days overdue (cadence: ${def.cadenceDays}d)`;
      } else {
        const remaining = def.cadenceDays - (daysSince ?? 0);
        statusStr = `✅ ok — ${remaining} days until due`;
      }

      console.log(
        `${padRight(def.name, 40)} ${padRight(lastRotatedStr, 20)} ${padRight(daysSinceStr, 12)} ${statusStr}`,
      );
    }

    console.log('');

    // ── Summary ───────────────────────────────────────────────────────────────
    if (staleSecrets.length === 0) {
      console.log('✅ All secrets are within their rotation cadence. Nothing to do.\n');
    } else {
      console.log(`⚠️  ${staleSecrets.length} secret(s) are stale or have never been rotated:\n`);

      for (const def of staleSecrets) {
        console.log(`  ${tierEmoji(def.tier)} ${def.name} (tier: ${def.tier}, cadence: ${def.cadenceDays}d)`);
        console.log(`     ${def.description}`);

        // Print the rotation playbook link / reminder
        if (def.name.startsWith('JWT_SIGNING_KEY')) {
          console.log(`     Run: npx ts-node scripts/secrets/rotate-jwt.ts`);
        } else {
          console.log(`     See: docs/runbooks/secrets-rotation.md#${def.name.toLowerCase().replace(/_/g, '-')}`);
        }
        console.log('');
      }

      console.log(
        `Action: Follow the playbook at docs/runbooks/secrets-rotation.md\n` +
          `Then record each rotation via POST /admin/secrets/:name/rotation-log\n`,
      );

      process.exit(1);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: Error) => {
  // Ensure we never accidentally log a secret value from a DB error message.
  const safeMessage = err.message
    .replace(/postgresql:\/\/[^\s]+/gi, '[DB_URL_REDACTED]')
    .replace(/password=[^\s&]*/gi, 'password=[REDACTED]');
  console.error(`\n[ERROR] ${safeMessage}\n`);
  process.exit(1);
});
