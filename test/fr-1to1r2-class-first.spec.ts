import 'reflect-metadata';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { AuditService } from '../src/audit/audit.service';
import { EmailService } from '../src/email/email.service';
import { InviteCodesService } from '../src/invite-codes/invite-codes.service';
import { InviteGrantService } from '../src/invite-grant/invite-grant.service';
import { PrismaService } from '../src/prisma.service';
import {
  COACH_A, addUser, buildAttachDb, fakeAnalytics, fakeAudit, fakeEmail, user,
} from './support/attach-fixture';

// FR-1TO1R2 (agent 185) class-first test. Class: every writer that creates, publishes,
// re-activates or picks a package to sell or grant reads its coach through the one coaching
// rule (src/packages/coach-selling.ts) BEFORE anything is written.
const src = (file: string) => readFileSync(join(__dirname, '..', 'src', file), 'utf8');

describe('FR-1TO1R2 class: every package publisher uses the one coaching rule first', () => {
  it.each([
    ['POST /packages (create, idempotent create)', 'packages/packages.controller.ts', /@Post\(\)\s+async create[\s\S]*?resolveSellingCoachId\(req\.user\.id\)/],
    ['PATCH /packages/:id with is_active true (re-activate)', 'packages/packages.controller.ts', /body\.is_active === true\s+\? await this\.packages\.resolveSellingCoachId/],
    ['POST /packages/:id/publish', 'packages/packages.controller.ts', /@Post\(':id\/publish'\)[\s\S]*?resolveSellingCoachId\(req\.user\.id\)/],
    ['resolveSellingCoachId', 'packages/packages.service.ts', /resolveSellingCoachId[\s\S]*?await assertCoachSelling\(this\.prisma, coachId\)/],
    ['join writer (code or link): coach read before any package is picked or published', 'invite-codes/invite-codes.service.ts', /const coach = await joinCoachFor\(this\.prisma, target\.coachId, buyerId\);\s+if \(!coach\) return null;[\s\S]*?findJoinPackage[\s\S]*?createGettingStartedPackage/],
    ['joinCoachFor', 'packages/coach-selling.ts', /where: \{ id: coachId, AND: \[coachingCoachFor\(buyerId\)\] \}/],
  ])('%s', (_path, file, rule) => {
    expect(src(file)).toMatch(rule);
  });

  it('has no package-creating writer outside that list', () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.spec.ts') && /coachPackage\.(create|createMany|upsert)\(/.test(readFileSync(p, 'utf8'))) hits.push(entry.name);
      }
    };
    walk(join(__dirname, '..', 'src'));
    expect(hits.sort()).toEqual(['join-package.ts', 'packages.service.ts']);
  });
});

// The join writer, over the real InviteCodesService + InviteGrantService on the stateful double.
type Seed = { name?: string; blockedByCoach?: boolean; blockedByBuyer?: boolean; pkg?: 'none' | 'free'; attached?: boolean };

async function fixture(seed: Seed) {
  const db = buildAttachDb();
  db.model('coachPackage', [['id']], () => ({
    archived_at: null, requires_contract: false, contract_template_id: null,
    interval_count: 1, duration_periods: null, created_at: new Date(),
  }));
  db.model('clientPurchase', [['id'], ['idempotency_key']]);
  Object.assign(user(db, COACH_A), { name: seed.name ?? 'Coach A' });
  addUser(db, { id: 'buyer', coach_id: seed.attached ? COACH_A : null });
  const blocks = [
    ...(seed.blockedByCoach ? [{ blocker_id: COACH_A, blocked_id: 'buyer' }] : []),
    ...(seed.blockedByBuyer ? [{ blocker_id: 'buyer', blocked_id: COACH_A }] : []),
  ];
  db.listRelations.blocks_set = (row) => blocks.filter((b) => b.blocker_id === row.id);
  db.listRelations.blocks_received = (row) => blocks.filter((b) => b.blocked_id === row.id);
  if (seed.pkg === 'free') {
    const now = new Date();
    db.state.coachPackage.push({
      id: 'starter', coach_id: COACH_A, name: 'Starter', amount_cents: 0, currency: 'usd',
      billing_type: 'one_time', interval: null, interval_count: 1, is_active: true, archived_at: null,
      published_at: now, first_published_at: now, requires_contract: false, contract_template_id: null,
      duration_periods: null, created_at: now,
    });
  }
  const module = await Test.createTestingModule({
    providers: [
      InviteCodesService, InviteGrantService,
      { provide: PrismaService, useValue: db },
      { provide: AnalyticsService, useValue: fakeAnalytics() },
      { provide: AuditService, useValue: fakeAudit() },
      { provide: EmailService, useValue: fakeEmail() },
    ],
  }).compile();
  return { db, invites: module.get(InviteCodesService), before: db.state.coachPackage.map((p) => ({ ...p })) };
}

describe('FR-1TO1R2 class: the join writer publishes and grants nothing for a refused coach', () => {
  const previous = process.env.FEATURE_CONTRACTS_ENABLED;
  beforeEach(() => { process.env.FEATURE_CONTRACTS_ENABLED = 'false'; });
  afterAll(() => {
    if (previous === undefined) delete process.env.FEATURE_CONTRACTS_ENABLED;
    else process.env.FEATURE_CONTRACTS_ENABLED = previous;
  });

  const refused: Array<[string, Seed]> = [
    ['nameless coach', { name: '' }],
    ['coach blocked the buyer', { blockedByCoach: true }],
    ['buyer blocked the coach', { blockedByBuyer: true }],
  ];
  const packages: Array<[string, Seed['pkg']]> = [
    ['no package yet (would create "Getting started")', 'none'],
    ['coach already has a usable free package (fallback pick)', 'free'],
  ];
  const rows = refused.flatMap(([who, seed]) => packages.map(([what, pkg]) => [`${who}, ${what}`, { ...seed, pkg }] as const));

  it.each(rows)('new join refused: %s', async (_l, seed) => {
    const { db, invites, before } = await fixture(seed);
    await expect(invites.attachUserToCoachByCode('buyer', 'GP-AAAAAA'))
      .rejects.toMatchObject({ response: { error: 'PACKAGE_NOT_FOUND' } });
    expect(user(db, 'buyer').coach_id).toBeNull();
    expect(db.state.clientPurchase).toHaveLength(0);
    expect(db.state.coachPackage).toEqual(before);
  });

  it.each(rows)('replay by an attached client stays a no-write success: %s', async (_l, seed) => {
    const { db, invites, before } = await fixture({ ...seed, attached: true });
    await expect(invites.attachUserToCoachByCode('buyer', 'GP-AAAAAA'))
      .resolves.toMatchObject({ coach_id: COACH_A, already_attached: true });
    expect(db.state.clientPurchase).toHaveLength(0);
    expect(db.state.coachPackage).toEqual(before);
  });

  it.each(packages)('named coach control: %s is granted and attached', async (_l, pkg) => {
    const { db, invites } = await fixture({ pkg });
    const out = await invites.attachUserToCoachByCode('buyer', 'GP-AAAAAA');
    expect(out).toMatchObject({ coach_id: COACH_A, grant: { status: 'created' } });
    expect(user(db, 'buyer').coach_id).toBe(COACH_A);
    expect(db.state.clientPurchase).toHaveLength(1);
    expect(db.state.coachPackage).toHaveLength(1);
    expect(db.state.coachPackage[0]).toMatchObject({
      name: pkg === 'free' ? 'Starter' : 'Getting started', is_active: true, published_at: expect.any(Date),
    });
  });
});
