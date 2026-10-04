#!/usr/bin/env ts-node
/**
 * scripts/set-coach-welcome-message.ts  (C05 item 6)
 *
 * Operator tool: enable/disable the 13-minute coach welcome message for ONE
 * coach and set that coach's template. Same validation and enabled_at rule as
 * the owner endpoint PUT /api/admin/coaches/:coachId/welcome-message (both
 * call src/engagement/welcome-settings.ts).
 *
 * The coach's real template is runtime data. Keep it in a private file
 * outside the repository and pass its path; the script never prints the
 * template text (only its length and sha256) so it does not end up in logs.
 *
 * Usage:
 *   DATABASE_URL=... npx ts-node scripts/set-coach-welcome-message.ts \
 *     --coach-email coach@example.com \
 *     --template-file /path/outside/repo/welcome.txt \
 *     --enable [--dry-run]
 *
 * Flags:
 *   --coach-id <uuid> | --coach-email <email>   which coach (required)
 *   --template-file <path>                       set the coach template
 *   --use-default                                clear back to the generic default
 *   --enable | --disable                         flip the flag
 *   --show                                       print current state only
 *   --dry-run                                    validate, write nothing
 *
 * Placeholders: {first_name} (client) and {coach_first_name}.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';
import {
  getWelcomeSettings,
  updateWelcomeSettings,
  type WelcomeSettingsUpdate,
  type WelcomeSettingsView,
} from '../src/engagement/welcome-settings';
import { validateWelcomeTemplate } from '../src/engagement/welcome-template';
import { parseArgs } from '../src/engagement/welcome-cli-args';

function summary(v: WelcomeSettingsView): string {
  const tpl = v.template;
  const sha = tpl ? createHash('sha256').update(tpl).digest('hex').slice(0, 16) : null;
  return JSON.stringify({
    coach_id: v.coach_id,
    enabled: v.enabled,
    enabled_at: v.enabled_at,
    template: tpl ? { custom: true, length: tpl.length, sha256_16: sha } : { custom: false },
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    let coachId = args.coachId;
    if (!coachId && args.coachEmail) {
      const u = await prisma.user.findFirst({
        where: { email: args.coachEmail, deleted_at: null },
        select: { id: true },
      });
      if (!u) throw new Error('coach not found for that email');
      coachId = u.id;
    }
    if (!coachId) throw new Error('coach not resolved');

    if (args.show) {
      process.stdout.write(`${summary(await getWelcomeSettings(prisma, coachId))}\n`);
      return;
    }

    const update: WelcomeSettingsUpdate = {};
    if (args.enable !== undefined) update.enabled = args.enable;
    if (args.useDefault) update.template = null;
    if (args.templateFile) {
      const raw = readFileSync(args.templateFile, 'utf8');
      const checked = validateWelcomeTemplate(raw);
      if (!checked.ok)
        throw new Error(
          `template rejected: ${checked.code}${checked.detail ? ` (${checked.detail})` : ''}`,
        );
      update.template = checked.template;
    }
    if (args.dryRun) {
      process.stdout.write(
        `dry-run ok: ${JSON.stringify({ coach_id: coachId, enabled: update.enabled, template: update.template === undefined ? 'unchanged' : update.template === null ? 'default' : `custom(${update.template.length})` })}\n`,
      );
      return;
    }
    const out = await updateWelcomeSettings(prisma, coachId, update, 'operator-script');
    process.stdout.write(`${summary(out)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `set-coach-welcome-message: ${err instanceof Error ? err.message : 'failed'}\n`,
    );
    process.exit(1);
  });
}
