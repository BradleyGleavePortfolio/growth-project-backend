// A1-COACHLESS — stateful fixture: the REAL canonical attach writer
// (InviteCodesService via attachServices) plus the real coachless services,
// all over one StatefulPrisma, so tests assert on persisted rows.
import {
  COACH_A,
  COACH_B,
  attachServices,
  buildAttachDb,
  fakeAudit,
  type AuditDouble,
} from '../support/attach-fixture';
import { StatefulPrisma } from '../support/stateful-prisma';
import type { PrismaService } from '../../src/prisma.service';
import type { AuditService } from '../../src/audit/audit.service';
import { CoachCodeLookupService } from '../../src/coachless/coach-code-lookup.service';
import { CoachCodeRedemptionService } from '../../src/coachless/coach-code-redemption.service';
import { CoachlessHomeService } from '../../src/coachless/coachless-home.service';
import { CoachlessPromptService } from '../../src/coachless/coachless-prompt.service';
import { FeaturedCoachService } from '../../src/coachless/featured-coach.service';

export { COACH_A, COACH_B };

export const PKG_B = 'pkg-b-monthly';
export const PKG_A = 'pkg-a-monthly';

/** The StatefulPrisma double stands in for PrismaService (same model surface). */
function asPrisma(db: StatefulPrisma): PrismaService {
  const svc: PrismaService = Object.assign(Object.create(null), db);
  return svc;
}

function asAudit(a: AuditDouble): AuditService {
  const svc: AuditService = Object.assign(Object.create(null), a);
  return svc;
}

export async function buildCoachless() {
  const db = buildAttachDb();
  db.model('userProfile', [['id'], ['user_id']]);
  db.model('coachPackage', [['id']]);
  db.model('featuredCoachConfig', [['id']]);
  db.model('coachCodeRedemption', [['id'], ['user_id', 'idempotency_key']]);
  db.model('coachlessPromptState', [['id'], ['user_id']], () => ({
    roman_seen_count: 0,
    roman_window_started_at: null,
    roman_last_seen_at: null,
    roman_not_now_count: 0,
    roman_not_now_at: null,
  }));
  db.relations.profile = (row) => db.state.userProfile.find((p) => p.user_id === row.id) ?? null;
  db.relations.coach_profile = (row) =>
    db.state.coachProfile.find((p) => p.user_id === row.id) ?? null;

  db.state.userProfile.push({
    id: 'up-b',
    user_id: COACH_B,
    avatar_url: 'https://cdn.example.test/b.jpg',
  });
  const b = db.state.coachProfile.find((p) => p.user_id === COACH_B);
  if (b)
    Object.assign(b, {
      business_name: 'B Training',
      bio: 'Strength coach',
      invite_code_package_id: null,
    });
  const a = db.state.coachProfile.find((p) => p.user_id === COACH_A);
  if (a) Object.assign(a, { business_name: null, bio: null, invite_code_package_id: null });
  db.state.coachPackage.push(pkg(PKG_B, COACH_B, 4900), pkg(PKG_A, COACH_A, 9900));

  const audit = fakeAudit();
  const { invites, analytics } = await attachServices(db, { audit });
  const prisma = asPrisma(db);
  const lookup = new CoachCodeLookupService(prisma);
  const featured = new FeaturedCoachService(prisma, lookup, asAudit(audit));
  const prompts = new CoachlessPromptService(prisma);
  const home = new CoachlessHomeService(featured, prompts);
  const redemption = new CoachCodeRedemptionService(
    prisma,
    invites,
    lookup,
    featured,
    asAudit(audit),
  );
  return { db, invites, analytics, audit, lookup, featured, prompts, home, redemption };
}

export function pkg(id: string, coach_id: string, amount_cents: number) {
  return {
    id,
    coach_id,
    name: 'Monthly coaching',
    description: 'Programs, check-ins and messaging',
    amount_cents,
    currency: 'usd',
    billing_type: 'recurring',
    interval: 'month',
    interval_count: 1,
    is_active: true,
    archived_at: null,
  };
}

/** Owner's featured offer for COACH_B (accepting, Roman on). */
export function featuredRow(over: Record<string, unknown> = {}) {
  return {
    id: 'default',
    coach_user_id: COACH_B,
    code: 'GP-BBBBBB',
    package_id: PKG_B,
    banner_title: 'Enter coach code for coaching and programs',
    offer_text: '$49/mo with our top coach; use code GP-BBBBBB',
    roman_pitch_text:
      'Sir/Ma’am, just so you’re aware, the top coach has available slots. Interested?',
    accepting_clients: true,
    roman_enabled: true,
    roman_min_hours_between: 24,
    roman_max_per_week: 3,
    roman_snooze_days: 14,
    roman_max_not_now: 2,
    updated_by_user_id: 'owner-1',
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

export const KEY1 = '11111111-1111-4111-8111-111111111111';
export const KEY2 = '22222222-2222-4222-8222-222222222222';
