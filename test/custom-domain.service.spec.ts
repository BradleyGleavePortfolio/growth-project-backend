/**
 * Unit tests for CustomDomainService (CNAME Phase 4).
 *
 * The headline test is the race-condition simulation: we fire two
 * concurrent claim() calls against an in-memory Prisma stub whose
 * `update` enforces the same uniqueness invariant the real Postgres
 * unique index does (throws P2002 on collision). Exactly one promise
 * MUST resolve and the other MUST reject with ConflictException — that
 * is the behavioural contract the production unique-index buys us, and
 * the contract Phase 4 promises.
 *
 * We also cover:
 *   - DNS verify integrates with DnsVerifier (timeout reason propagates)
 *   - free-tier coaches receive 402 PAYMENT_REQUIRED
 *   - input normalisation strips scheme/path/port + lowercases
 *   - release() is idempotent
 */

import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { CustomDomainService } from '../src/landing-pages/custom-domain.service';
import { DnsVerifier } from '../src/landing-pages/dns-verifier';

// ─── Prisma stub w/ unique-index simulation ──────────────────────────────────

type Page = {
  id: string;
  coach_id: string;
  custom_domain: string | null;
  custom_domain_verified_at: Date | null;
};

type Sub = {
  coach_id: string;
  tier: 'free' | 'pro' | 'enterprise';
};

function uniqueViolation(): Error {
  const err: any = new Error(
    'Unique constraint failed on the fields: (`custom_domain`)',
  );
  err.code = 'P2002';
  err.meta = { target: ['custom_domain'] };
  return err;
}

function makePrisma(pages: Page[], subs: Sub[]) {
  const claim = async (pageId: string, domain: string) => {
    // Simulate Postgres unique-index check at COMMIT time.
    const taken = pages.find(
      (p) => p.custom_domain === domain && p.id !== pageId,
    );
    if (taken) throw uniqueViolation();
    const page = pages.find((p) => p.id === pageId);
    if (!page) throw new Error(`page ${pageId} not found`);
    page.custom_domain = domain;
    page.custom_domain_verified_at = null;
    return page;
  };

  return {
    _pages: pages,
    _subs: subs,
    coachLandingPage: {
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          pages.find((p) => {
            if (where.id && p.id !== where.id) return false;
            if (where.coach_id && p.coach_id !== where.coach_id) return false;
            return true;
          }) ?? null
        );
      }),
      update: jest.fn(async ({ where, data }: any) => {
        // top-level update path (release only — verify success now uses updateMany).
        const page = pages.find((p) => p.id === where.id);
        if (!page) throw new Error('page not found');
        if (data.custom_domain !== undefined) {
          if (data.custom_domain === null) {
            page.custom_domain = null;
          } else {
            const collision = pages.find(
              (p) => p.custom_domain === data.custom_domain && p.id !== page.id,
            );
            if (collision) throw uniqueViolation();
            page.custom_domain = data.custom_domain;
          }
        }
        if (data.custom_domain_verified_at !== undefined) {
          page.custom_domain_verified_at = data.custom_domain_verified_at;
        }
        return { ...page };
      }),
      // verify() uses updateMany to re-assert `custom_domain` in the WHERE
      // clause — closing the TOCTOU window between the ownership read and
      // the verified_at stamp. We honor the full where shape so the test
      // can exercise both the match and no-match paths.
      updateMany: jest.fn(async ({ where, data }: any) => {
        const matches = pages.filter((p) => {
          if (where.id && p.id !== where.id) return false;
          if (where.custom_domain !== undefined && p.custom_domain !== where.custom_domain) {
            return false;
          }
          return true;
        });
        for (const page of matches) {
          if (data.custom_domain_verified_at !== undefined) {
            page.custom_domain_verified_at = data.custom_domain_verified_at;
          }
          if (data.custom_domain !== undefined) {
            page.custom_domain = data.custom_domain;
          }
        }
        return { count: matches.length };
      }),
      // Used by verify() after the stamp UPDATE to surface the authoritative
      // server timestamp in the response.
      findUnique: jest.fn(async ({ where }: any) => {
        const p = pages.find((page) => page.id === where.id);
        return p ? { ...p } : null;
      }),
    },
    coachSubscription: {
      findUnique: jest.fn(async ({ where }: any) =>
        subs.find((s) => s.coach_id === where.coach_id) ?? null,
      ),
    },
    $transaction: jest.fn(async (fn: any) => {
      // Provide an inner "tx" with the same shape — the service uses
      // tx.coachLandingPage.findFirst + tx.coachLandingPage.update.
      const tx = {
        coachLandingPage: {
          findFirst: async ({ where }: any) =>
            pages.find((p) => {
              if (where.id && p.id !== where.id) return false;
              if (where.coach_id && p.coach_id !== where.coach_id) return false;
              return true;
            }) ?? null,
          update: async ({ where, data }: any) => {
            const page = await claim(where.id, data.custom_domain);
            return { id: page.id, custom_domain: page.custom_domain };
          },
        },
      };
      return fn(tx);
    }),
  } as any;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDnsStub(outcome: any): DnsVerifier {
  return {
    verifyCname: jest.fn().mockResolvedValue(outcome),
  } as unknown as DnsVerifier;
}

const PRO: Sub = { coach_id: 'coach-1', tier: 'pro' };
const FREE: Sub = { coach_id: 'coach-free', tier: 'free' };

function makePage(over: Partial<Page> = {}): Page {
  return {
    id: 'page-1',
    coach_id: 'coach-1',
    custom_domain: null,
    custom_domain_verified_at: null,
    ...over,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CustomDomainService', () => {
  describe('claim()', () => {
    it('binds a domain to a page on the happy path', async () => {
      const prisma = makePrisma([makePage()], [PRO]);
      const svc = new CustomDomainService(prisma, makeDnsStub({ status: 'ok' }));

      const out = await svc.claim('coach-1', 'page-1', 'Coaching.Example.com');
      expect(out.custom_domain).toBe('coaching.example.com');
      expect(out.verified).toBe(false);
      expect(out.cname_target).toBeTruthy();
      expect(prisma._pages[0].custom_domain).toBe('coaching.example.com');
      // (Re)claim resets verified_at to null
      expect(prisma._pages[0].custom_domain_verified_at).toBeNull();
    });

    it('strips scheme, path, and port from user input before validating', async () => {
      const prisma = makePrisma([makePage()], [PRO]);
      const svc = new CustomDomainService(prisma, makeDnsStub({ status: 'ok' }));

      const out = await svc.claim(
        'coach-1',
        'page-1',
        'https://coaching.example.com:443/sales',
      );
      expect(out.custom_domain).toBe('coaching.example.com');
    });

    it('rejects malformed domains with 400', async () => {
      const prisma = makePrisma([makePage()], [PRO]);
      const svc = new CustomDomainService(prisma, makeDnsStub({ status: 'ok' }));

      await expect(svc.claim('coach-1', 'page-1', 'not a domain')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(svc.claim('coach-1', 'page-1', 'no-tld')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(svc.claim('coach-1', 'page-1', 'under_score.example.com')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('returns 402 PAYMENT_REQUIRED for free-tier coaches', async () => {
      const freePage = makePage({ id: 'page-free', coach_id: 'coach-free' });
      const prisma = makePrisma([freePage], [FREE]);
      const svc = new CustomDomainService(prisma, makeDnsStub({ status: 'ok' }));

      await expect(
        svc.claim('coach-free', 'page-free', 'coaching.example.com'),
      ).rejects.toMatchObject({
        status: HttpStatus.PAYMENT_REQUIRED,
      });
    });

    it('treats coaches with no CoachSubscription row as free (402)', async () => {
      const orphanPage = makePage({ id: 'page-orphan', coach_id: 'coach-orphan' });
      const prisma = makePrisma([orphanPage], []); // no subscription row
      const svc = new CustomDomainService(prisma, makeDnsStub({ status: 'ok' }));

      const thrown = await svc
        .claim('coach-orphan', 'page-orphan', 'a.example.com')
        .catch((e) => e);
      expect(thrown).toBeInstanceOf(HttpException);
      expect((thrown as HttpException).getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
    });

    it('throws NotFoundException when the page does not belong to the coach', async () => {
      const prisma = makePrisma(
        [makePage({ coach_id: 'someone-else' })],
        [PRO],
      );
      const svc = new CustomDomainService(prisma, makeDnsStub({ status: 'ok' }));

      await expect(
        svc.claim('coach-1', 'page-1', 'a.example.com'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('RACE CONDITION: two concurrent claims for the same domain → exactly one winner', async () => {
      // Two pages owned by two different coaches racing for the same domain.
      const pages: Page[] = [
        makePage({ id: 'page-A', coach_id: 'coach-1' }),
        makePage({ id: 'page-B', coach_id: 'coach-2' }),
      ];
      const subs: Sub[] = [
        { coach_id: 'coach-1', tier: 'pro' },
        { coach_id: 'coach-2', tier: 'enterprise' },
      ];
      const prisma = makePrisma(pages, subs);
      const svc = new CustomDomainService(prisma, makeDnsStub({ status: 'ok' }));

      const results = await Promise.allSettled([
        svc.claim('coach-1', 'page-A', 'contested.example.com'),
        svc.claim('coach-2', 'page-B', 'contested.example.com'),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exactly one winner, exactly one loser.
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // The loser MUST be a ConflictException (P2002 translated by the service).
      const loser = rejected[0] as PromiseRejectedResult;
      expect(loser.reason).toBeInstanceOf(ConflictException);
      expect(loser.reason.getResponse()).toMatchObject({
        error: 'domain_already_claimed',
      });

      // And the DB state reflects exactly one binding.
      const bound = pages.filter((p) => p.custom_domain === 'contested.example.com');
      expect(bound).toHaveLength(1);
    });

    it('lets the same coach re-claim the same domain on the same page (idempotent, but resets verified_at)', async () => {
      const page = makePage({
        custom_domain: 'mine.example.com',
        custom_domain_verified_at: new Date('2026-01-01'),
      });
      const prisma = makePrisma([page], [PRO]);
      const svc = new CustomDomainService(prisma, makeDnsStub({ status: 'ok' }));

      const out = await svc.claim('coach-1', 'page-1', 'mine.example.com');
      expect(out.custom_domain).toBe('mine.example.com');
      expect(out.verified).toBe(false);
      expect(page.custom_domain_verified_at).toBeNull();
    });
  });

  describe('verify()', () => {
    it('stamps custom_domain_verified_at on status=ok', async () => {
      const page = makePage({ custom_domain: 'mine.example.com' });
      const prisma = makePrisma([page], [PRO]);
      const svc = new CustomDomainService(
        prisma,
        makeDnsStub({ status: 'ok', targets: ['cname.trygrowthproject.com'] }),
      );

      const out = await svc.verify('coach-1', 'page-1');
      expect(out.outcome).toEqual({
        status: 'ok',
        targets: ['cname.trygrowthproject.com'],
      });
      expect(out.verified_at).toBeInstanceOf(Date);
      expect(page.custom_domain_verified_at).toBeInstanceOf(Date);
    });

    it('does NOT stamp verified_at on status=timeout (and returns 200 with outcome)', async () => {
      const page = makePage({ custom_domain: 'slow.example.com' });
      const prisma = makePrisma([page], [PRO]);
      const svc = new CustomDomainService(
        prisma,
        makeDnsStub({ status: 'timeout' }),
      );

      const out = await svc.verify('coach-1', 'page-1');
      expect(out.outcome).toEqual({ status: 'timeout' });
      expect(out.verified_at).toBeNull();
      expect(page.custom_domain_verified_at).toBeNull();
    });

    it('does NOT stamp verified_at on status=wrong_target', async () => {
      const page = makePage({ custom_domain: 'mine.example.com' });
      const prisma = makePrisma([page], [PRO]);
      const svc = new CustomDomainService(
        prisma,
        makeDnsStub({ status: 'wrong_target', targets: ['someone-else.net'] }),
      );

      const out = await svc.verify('coach-1', 'page-1');
      expect(out.outcome.status).toBe('wrong_target');
      expect(out.verified_at).toBeNull();
    });

    it('throws 400 when no domain has been claimed', async () => {
      const prisma = makePrisma([makePage()], [PRO]);
      const svc = new CustomDomainService(prisma, makeDnsStub({ status: 'ok' }));

      await expect(svc.verify('coach-1', 'page-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws 404 when the page does not belong to the coach', async () => {
      const prisma = makePrisma(
        [makePage({ coach_id: 'someone-else', custom_domain: 'x.example.com' })],
        [PRO],
      );
      const svc = new CustomDomainService(prisma, makeDnsStub({ status: 'ok' }));

      await expect(svc.verify('coach-1', 'page-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it(
      'TOCTOU: refuses to stamp verified_at if custom_domain swapped during the DNS window',
      async () => {
        // Reproduce P2-1: the coach DNS-verifies `verified.example.com`,
        // but between the ownership read and the post-DNS stamp UPDATE
        // re-claims to `attacker.example.com`. The fix re-asserts the
        // verified domain in the WHERE clause; the stamp must miss and
        // we must report `domain_changed` rather than falsely stamping
        // the new (unverified) host.
        const page = makePage({ custom_domain: 'verified.example.com' });
        const prisma = makePrisma([page], [PRO]);

        // DNS stub mutates the bound domain mid-lookup — simulating a
        // concurrent re-claim landing during the 3s DNS window.
        const dns: DnsVerifier = {
          verifyCname: jest.fn(async () => {
            page.custom_domain = 'attacker.example.com';
            return { status: 'ok', targets: ['cname.trygrowthproject.com'] };
          }),
        } as unknown as DnsVerifier;

        const svc = new CustomDomainService(prisma, dns);
        const out = await svc.verify('coach-1', 'page-1');

        // Outcome surfaces the race; verified_at is NOT stamped.
        expect(out.outcome).toEqual({ status: 'domain_changed' });
        expect(out.verified_at).toBeNull();
        expect(page.custom_domain).toBe('attacker.example.com');
        expect(page.custom_domain_verified_at).toBeNull();
        // The response reports the domain we actually DNS-verified, not
        // the post-swap value the row now holds.
        expect(out.custom_domain).toBe('verified.example.com');
      },
    );
  });

  describe('release()', () => {
    it('clears the binding + verified_at', async () => {
      const page = makePage({
        custom_domain: 'gone.example.com',
        custom_domain_verified_at: new Date(),
      });
      const prisma = makePrisma([page], [PRO]);
      const svc = new CustomDomainService(prisma, makeDnsStub({ status: 'ok' }));

      const out = await svc.release('coach-1', 'page-1');
      expect(out).toEqual({ ok: true });
      expect(page.custom_domain).toBeNull();
      expect(page.custom_domain_verified_at).toBeNull();
    });

    it('is idempotent on a page with no binding', async () => {
      const prisma = makePrisma([makePage()], [PRO]);
      const svc = new CustomDomainService(prisma, makeDnsStub({ status: 'ok' }));

      await expect(svc.release('coach-1', 'page-1')).resolves.toEqual({ ok: true });
    });

    it('throws 404 when the page is not owned by the coach', async () => {
      const prisma = makePrisma(
        [makePage({ coach_id: 'someone-else' })],
        [PRO],
      );
      const svc = new CustomDomainService(prisma, makeDnsStub({ status: 'ok' }));

      await expect(svc.release('coach-1', 'page-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
