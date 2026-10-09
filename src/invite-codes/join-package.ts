import type { CoachPackage, InviteGrantMode, Prisma } from '@prisma/client';
import { isFreeOffer } from '../packages/packages.service';

// B-PACKAGE-135 — owner 2026-10-09: a coached client ALWAYS has a package.
// Every coach code or link carries exactly one: (1) the package the coach
// picked for that code while usable, else (2) the coach's first usable
// package (oldest first), else (3) a free "Getting started" package created
// the first time it is needed. Usable = own, active, not archived, published,
// no signed coach agreement needed. Free (a $0 package, or a free / prepaid
// code) -> granted at once via the $0 grant path; paid -> the existing in-app
// checkout, coachless until the purchase's entitlement attaches them.

export const GETTING_STARTED_PACKAGE_NAME = 'Getting started';

type PackageDb = Pick<Prisma.TransactionClient, 'coachPackage'>;

/** The package screen after a code or link is accepted. */
export type JoinPackageView = {
  id: string;
  name: string;
  amount_cents: number;
  currency: string;
  billing_type: string;
  interval: string | null;
  interval_count: number;
  recurring_amount_cents: number | null;
  recurring_interval: string | null;
  recurring_interval_count: number | null;
  duration_periods: number | null;
  trial_days: number;
  /** True when the client pays nothing in the app for this join. */
  is_free: boolean;
};

export type JoinOutcome = {
  /** granted = attached with the package now; checkout_required = pay in the app first, still coachless. */
  status: 'granted' | 'checkout_required';
  /** How a granted package was given: free ($0 or a free code) or prepaid (paid to the coach outside the app). */
  grant_mode: InviteGrantMode;
  package: JoinPackageView;
  coach: { id: string; first_name: string };
  /** The stored code; the app sends it as `join_code` to the checkout for a paid join. */
  code: string;
};

function usable(pkg: CoachPackage | null, coachId: string): pkg is CoachPackage {
  return (
    !!pkg &&
    pkg.coach_id === coachId &&
    pkg.is_active &&
    !pkg.archived_at &&
    !!pkg.published_at &&
    !(pkg.requires_contract && pkg.contract_template_id)
  );
}

/** Steps 1 and 2 above (no write). Null only for a coach with no usable package. */
export async function findJoinPackage(
  db: PackageDb,
  coachId: string,
  pickedPackageId: string | null,
): Promise<CoachPackage | null> {
  if (pickedPackageId) {
    const picked = await db.coachPackage.findUnique({ where: { id: pickedPackageId } });
    if (usable(picked, coachId)) return picked;
  }
  const first = await db.coachPackage.findFirst({
    where: {
      coach_id: coachId,
      is_active: true,
      archived_at: null,
      published_at: { not: null },
      NOT: { requires_contract: true, contract_template_id: { not: null } },
    },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
  });
  return usable(first, coachId) ? first : null;
}

/** Step 3: the coach's free "Getting started" package, published so it can be joined at once. */
export async function createGettingStartedPackage(
  db: PackageDb,
  coachId: string,
): Promise<CoachPackage> {
  const now = new Date();
  return db.coachPackage.create({
    data: {
      coach_id: coachId,
      name: GETTING_STARTED_PACKAGE_NAME,
      amount_cents: 0,
      currency: 'usd',
      billing_type: 'one_time',
      is_active: true,
      published_at: now,
      first_published_at: now,
    },
  });
}

/**
 * How this join is given. The coach's free / prepaid choice for the picked
 * package stands; otherwise a $0 one-time package is free and anything else
 * is paid in the app ('none').
 */
export function joinGrantMode(
  pkg: CoachPackage,
  picked: { package_id: string | null; grant_mode: InviteGrantMode } | null,
): InviteGrantMode {
  if (picked && picked.package_id === pkg.id && picked.grant_mode !== 'none') return picked.grant_mode;
  return isFreeOffer(pkg) ? 'free' : 'none';
}

export function joinPackageView(pkg: CoachPackage, mode: InviteGrantMode): JoinPackageView {
  return {
    id: pkg.id,
    name: pkg.name,
    amount_cents: pkg.amount_cents,
    currency: pkg.currency,
    billing_type: pkg.billing_type,
    interval: pkg.interval ?? null,
    interval_count: pkg.interval_count,
    recurring_amount_cents: pkg.recurring_amount_cents ?? null,
    recurring_interval: pkg.recurring_interval ?? null,
    recurring_interval_count: pkg.recurring_interval_count ?? null,
    duration_periods: pkg.duration_periods ?? null,
    trial_days: pkg.trial_days ?? 0,
    is_free: mode === 'free',
  };
}

export function coachFirstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

/**
 * The paid join completes: in the purchase's entitlement transaction a buyer
 * who is a student with NO coach becomes the package coach's client. Never
 * re-parents (a client of any coach is left alone) and never rewrites a role.
 */
export async function attachPaidJoinTx(
  tx: Pick<Prisma.TransactionClient, 'user'>,
  clientId: string,
  coachId: string,
): Promise<boolean> {
  const res = await tx.user.updateMany({
    where: { id: clientId, role: 'student', coach_id: null },
    data: { coach_id: coachId },
  });
  return res.count === 1;
}
