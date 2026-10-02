/**
 * S-FEE round 4 (B-629-3) — the first_published_at backfill on a populated
 * database.
 *
 * prisma/migrations/20270216000000_package_first_published_at backfills the
 * durable "was this package ever on sale" timestamp. At 858eb40b its purchase
 * branch read every ClientPurchase, including the $0 invite-grant and
 * free-claim rows #595 writes (`source` set) for packages that were never
 * published. A below-floor draft with only grants was then treated as
 * grandfathered and could be published under $19.99.
 *
 * This spec runs the real migration file against a populated fixture (SQLite
 * through python3's sqlite3, the one SQL engine available in every CI runner;
 * the only rewrite is `ADD COLUMN IF NOT EXISTS` -> `ADD COLUMN`, which SQLite
 * lacks), then publishes each backfilled row through PackagesService:
 *   - grant-only drafts (active grant, pending-consent grant): no history,
 *     publish still refused with PACKAGE_PRICE_BELOW_MINIMUM;
 *   - controls: a real sale (later unpublished), a guest checkout and a package
 *     published now keep their history and republish at their old price;
 *   - a grant before a real sale dates the history from the sale.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoachPackage } from '@prisma/client';
import { PackagesService } from '../src/packages/packages.service';
import type { PrismaService } from '../src/prisma.service';
import type { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';

type Row = Record<string, unknown>;

const asPrisma = (m: object): PrismaService => m as PrismaService;
const asScope = (m: object): SubCoachScopeService => m as SubCoachScopeService;

const MIGRATION = join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20270216000000_package_first_published_at',
  'migration.sql',
);

const COACH = 'coach-1';
const T0 = '2026-03-01T10:00:00.000Z';
const T1 = '2026-04-01T10:00:00.000Z';
const T2 = '2026-05-01T10:00:00.000Z';

// Every package is $10 one-time (below the $19.99 floor) unless noted.
const PACKAGES: Row[] = [
  { id: 'pkg_grant_active', published_at: null },
  { id: 'pkg_grant_pending', published_at: null },
  { id: 'pkg_sold_then_unpublished', published_at: null },
  { id: 'pkg_guest_checkout', published_at: null },
  { id: 'pkg_live', published_at: T0 },
  { id: 'pkg_grant_then_sale', published_at: null },
  { id: 'pkg_never', published_at: null },
];

const PURCHASES: Row[] = [
  // #595 invite grants: $0 rows with a source, on drafts.
  {
    id: 'cp1',
    package_id: 'pkg_grant_active',
    amount_cents: 0,
    source: 'invite_grant:free',
    status: 'active',
    created_at: T0,
  },
  {
    id: 'cp2',
    package_id: 'pkg_grant_pending',
    amount_cents: 0,
    source: 'invite_grant:prepaid',
    status: 'pending_consent',
    created_at: T0,
  },
  // A real Stripe purchase (source NULL) on a package that was later unpublished.
  {
    id: 'cp3',
    package_id: 'pkg_sold_then_unpublished',
    amount_cents: 1000,
    source: null,
    status: 'active',
    created_at: T1,
  },
  // A grant first, then a real sale.
  {
    id: 'cp4',
    package_id: 'pkg_grant_then_sale',
    amount_cents: 0,
    source: 'invite_grant:free',
    status: 'active',
    created_at: T0,
  },
  {
    id: 'cp5',
    package_id: 'pkg_grant_then_sale',
    amount_cents: 1000,
    source: null,
    status: 'active',
    created_at: T2,
  },
];

const GUEST_CHECKOUTS: Row[] = [{ id: 'gc1', package_id: 'pkg_guest_checkout', created_at: T1 }];

// Runs migration.sql on SQLite with the fixture loaded; prints the packages.
const RUNNER = String.raw`
import json, sqlite3, sys
fx = json.load(sys.stdin)
sql = open(sys.argv[1]).read().replace('ADD COLUMN IF NOT EXISTS', 'ADD COLUMN')
db = sqlite3.connect(':memory:')
db.executescript('''
CREATE TABLE "CoachPackage" ("id" TEXT PRIMARY KEY, "published_at" TEXT);
CREATE TABLE "ClientPurchase" ("id" TEXT PRIMARY KEY, "package_id" TEXT, "amount_cents" INTEGER NOT NULL,
  "source" TEXT, "status" TEXT, "created_at" TEXT NOT NULL);
CREATE TABLE "GuestCheckout" ("id" TEXT PRIMARY KEY, "package_id" TEXT, "created_at" TEXT NOT NULL);
''')
for table, rows in (('CoachPackage', fx['packages']), ('ClientPurchase', fx['purchases']), ('GuestCheckout', fx['guest'])):
    for r in rows:
        cols = ', '.join('"%s"' % k for k in r)
        db.execute('INSERT INTO "%s" (%s) VALUES (%s)' % (table, cols, ', '.join('?' * len(r))), list(r.values()))
db.executescript(sql)
out = [dict(id=i, published_at=p, first_published_at=f) for i, p, f in
       db.execute('SELECT "id", "published_at", "first_published_at" FROM "CoachPackage" ORDER BY "id"')]
print(json.dumps(out))
`;

function runMigration(): Array<{
  id: string;
  published_at: string | null;
  first_published_at: string | null;
}> {
  const res = spawnSync('python3', ['-c', RUNNER, MIGRATION], {
    input: JSON.stringify({ packages: PACKAGES, purchases: PURCHASES, guest: GUEST_CHECKOUTS }),
    encoding: 'utf8',
  });
  if (res.error || res.status !== 0) {
    throw new Error(
      `could not run the migration fixture with python3/sqlite3: ${res.error?.message ?? res.stderr}`,
    );
  }
  return JSON.parse(res.stdout);
}

function serviceOver(rows: Row[]) {
  const coachPackage = {
    findFirst: async ({ where }: { where: Row }) => {
      const r = rows.find((x) => Object.entries(where).every(([k, v]) => x[k] === v));
      return r ? { ...r } : null;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const r = rows.find((x) => x.id === where.id)!;
      Object.assign(r, data);
      return { ...r };
    },
  };
  return new PackagesService(
    asPrisma({ coachPackage }),
    asScope({ getHeadCoachIdForSubCoach: async () => null }),
  );
}

function packageRow(
  id: string,
  published_at: string | null,
  first_published_at: string | null,
): Row {
  const row: Partial<CoachPackage> = {
    id,
    coach_id: COACH,
    name: 'Intro',
    description: null,
    amount_cents: 1_000,
    currency: 'usd',
    billing_type: 'one_time',
    interval: null,
    interval_count: 1,
    duration_periods: null,
    recurring_amount_cents: null,
    recurring_interval: null,
    recurring_interval_count: null,
    archived_at: null,
    published_at: published_at ? new Date(published_at) : null,
    first_published_at: first_published_at ? new Date(first_published_at) : null,
  };
  return row as Row;
}

describe('B-629-3: first_published_at backfill on a populated fixture', () => {
  it('uses only real Stripe purchases ("source" IS NULL AND "amount_cents" > 0) and guest checkouts', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    expect(sql).toMatch(
      /SELECT "package_id", "created_at" FROM "ClientPurchase"\s+WHERE "source" IS NULL AND "amount_cents" > 0\s+UNION ALL/,
    );
  });

  it('grant-only drafts get no history; sold, guest-checkout and live packages keep theirs', () => {
    const byId = Object.fromEntries(runMigration().map((r) => [r.id, r.first_published_at]));
    expect(byId).toEqual({
      pkg_grant_active: null,
      pkg_grant_pending: null,
      pkg_never: null,
      pkg_sold_then_unpublished: T1,
      pkg_guest_checkout: T1,
      pkg_live: T0,
      // The grant at T0 is not evidence; the sale at T2 is.
      pkg_grant_then_sale: T2,
    });
  });

  it('publishing after the backfill: grant-only $10 drafts are still refused; the controls republish', async () => {
    const rows = runMigration().map((r) => packageRow(r.id, r.published_at, r.first_published_at));
    const svc = serviceOver(rows);
    for (const id of ['pkg_grant_active', 'pkg_grant_pending', 'pkg_never']) {
      await expect(svc.publish(COACH, id)).rejects.toMatchObject({
        response: {
          code: 'PACKAGE_PRICE_BELOW_MINIMUM',
          message: 'Paid packages start at $19.99, or make it free.',
          minimum_cents: 1_999,
        },
      });
      expect(rows.find((r) => r.id === id)!.published_at).toBeNull();
    }
    for (const id of [
      'pkg_sold_then_unpublished',
      'pkg_guest_checkout',
      'pkg_live',
      'pkg_grant_then_sale',
    ]) {
      const published = await svc.publish(COACH, id);
      expect(published.published_at).toBeInstanceOf(Date);
      expect(published.amount_cents).toBe(1_000);
    }
  });
});
