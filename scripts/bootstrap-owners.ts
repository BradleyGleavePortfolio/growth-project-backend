/**
 * scripts/bootstrap-owners.ts
 *
 * Phase 1A bootstrap. Run after the OWNER + CoachProfile migration is
 * applied. Two jobs, both idempotent:
 *
 *   1. Promote a fixed list of OWNER emails to role=owner.
 *   2. For every existing coach (role=coach) without a CoachProfile row,
 *      create one with a unique invite_code.
 *
 * Owner emails come from the BOOTSTRAP_OWNER_EMAILS env var
 * (comma-separated). Defaults to the two named owners on file:
 * Bradley + Dynasia. Re-running is safe; existing rows are not modified.
 *
 * Usage:
 *   npx ts-node scripts/bootstrap-owners.ts
 *
 *   BOOTSTRAP_OWNER_EMAILS="bradley@x.com,dynasia@x.com" \
 *     npx ts-node scripts/bootstrap-owners.ts
 */

import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;
const CODE_PREFIX = 'GP-';

function generateInviteCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = CODE_PREFIX;
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

const DEFAULT_OWNER_EMAILS = [
  'bradley@thegrowthproject.courses',
  'dynasiaeimer@gmail.com',
];

async function main() {
  const prisma = new PrismaClient();
  try {
    const ownerEmails =
      (process.env.BOOTSTRAP_OWNER_EMAILS || DEFAULT_OWNER_EMAILS.join(','))
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

    let promoted = 0;
    let skippedMissing = 0;
    for (const email of ownerEmails) {
      const u = await prisma.user.findUnique({ where: { email } });
      if (!u) {
        skippedMissing++;
        console.warn(`[bootstrap-owners] skip: no User with email=${email}`);
        continue;
      }
      if (u.role === 'owner') continue;
      await prisma.user.update({
        where: { id: u.id },
        data: { role: 'owner' },
      });
      promoted++;
      console.log(`[bootstrap-owners] promoted ${email} -> owner`);
    }

    const coachesNeedingProfile = await prisma.user.findMany({
      where: { role: 'coach', coach_profile: null },
      select: { id: true, email: true, name: true },
    });

    let backfilled = 0;
    for (const c of coachesNeedingProfile) {
      let attempt = 0;
      while (attempt < 8) {
        const code = generateInviteCode();
        try {
          await prisma.coachProfile.create({
            data: {
              user_id: c.id,
              invite_code: code,
              business_name: c.name,
            },
          });
          backfilled++;
          break;
        } catch (err: any) {
          if (err?.code === 'P2002') {
            attempt++;
            continue;
          }
          throw err;
        }
      }
    }

    console.log(
      `[bootstrap-owners] done. promoted=${promoted} skipped_missing=${skippedMissing} coach_profiles_backfilled=${backfilled}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[bootstrap-owners] failed', err);
  process.exit(1);
});
