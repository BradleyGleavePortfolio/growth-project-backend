/**
 * R49 CoachDomainsService unit tests.
 *
 * In-memory Prisma stub mirrors the pattern used in
 * landing-pages.service.spec.ts.  We do NOT mock DomainDnsService
 * at this layer; instead we hand it a stubbed instance via the
 * constructor so each test controls verify() directly.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  CoachDomainsService,
  rollupStatus,
} from '../src/landing-pages/domains/domains.service';

function makePrisma() {
  const pages: any[] = [];
  const domains: any[] = [];
  const subs: any[] = [];
  return {
    _pages: pages,
    _domains: domains,
    _subs: subs,
    coachLandingPage: {
      findFirst: jest.fn(async ({ where }: any) => {
        const hit = pages.find(
          (p) => p.id === where.id && (!where.coach_id || p.coach_id === where.coach_id),
        );
        return hit ?? null;
      }),
    },
    coachSubscription: {
      findFirst: jest.fn(async ({ where }: any) =>
        subs.find((s) => s.coach_id === where.coach_id) ?? null,
      ),
    },
    coachLandingPageDomain: {
      create: jest.fn(async ({ data }: any) => {
        const dup = domains.find((d) => d.domain === data.domain);
        if (dup) {
          const err = new Error('unique violation');
          (err as any).code = 'P2002';
          throw err;
        }
        const row = {
          id: `dom-${domains.length + 1}`,
          verification_status: 'pending',
          cert_status: 'none',
          cert_issued_at: null,
          cert_expires_at: null,
          fly_cert_id: null,
          last_check_at: null,
          last_error: null,
          created_at: new Date(),
          updated_at: new Date(),
          ...data,
        };
        domains.push(row);
        return row;
      }),
      findMany: jest.fn(async ({ where, orderBy }: any) => {
        let rows = domains.filter((d) => {
          if (where?.landing_page_id && d.landing_page_id !== where.landing_page_id) return false;
          if (where?.coach_id && d.coach_id !== where.coach_id) return false;
          if (where?.OR) {
            return where.OR.some((c: any) => matchesWhere(d, c));
          }
          return true;
        });
        if (orderBy?.created_at === 'asc') rows = [...rows].sort((a, b) => +a.created_at - +b.created_at);
        if (orderBy?.created_at === 'desc') rows = [...rows].sort((a, b) => +b.created_at - +a.created_at);
        return rows;
      }),
      findFirst: jest.fn(async ({ where }: any) =>
        domains.find((d) =>
          Object.entries(where).every(([k, v]) => d[k] === v),
        ) ?? null,
      ),
      findUnique: jest.fn(async ({ where, select, include }: any) => {
        const row = domains.find((d) => {
          if (where.id && d.id !== where.id) return false;
          if (where.domain && d.domain !== where.domain) return false;
          return true;
        });
        if (!row) return null;
        if (include?.landing_page) {
          const page = pages.find((p) => p.id === row.landing_page_id);
          return { ...row, landing_page: page ?? null };
        }
        if (select) {
          const projected: any = {};
          for (const k of Object.keys(select)) projected[k] = row[k];
          return projected;
        }
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const idx = domains.findIndex((d) => d.id === where.id);
        if (idx === -1) throw new Error('not found');
        // Strip undefined values (Prisma semantics: undefined = no change).
        const clean: any = {};
        for (const [k, v] of Object.entries(data)) if (v !== undefined) clean[k] = v;
        Object.assign(domains[idx], clean, { updated_at: new Date() });
        return domains[idx];
      }),
      delete: jest.fn(async ({ where }: any) => {
        const idx = domains.findIndex((d) => d.id === where.id);
        if (idx !== -1) domains.splice(idx, 1);
        return {};
      }),
    },
  };
}

function matchesWhere(row: any, cond: any): boolean {
  for (const [k, v] of Object.entries(cond)) {
    if (v && typeof v === 'object' && 'lte' in (v as any)) {
      if (!(row[k] instanceof Date) || row[k].getTime() > (v as any).lte.getTime()) return false;
    } else if (v && typeof v === 'object' && 'not' in (v as any)) {
      if (row[k] === null || row[k] === (v as any).not) return false;
    } else if (row[k] !== v) {
      return false;
    }
  }
  return true;
}

function makeDns(verifyReturns: { verified: boolean; reason?: string } = { verified: true }) {
  return {
    verify: jest.fn().mockResolvedValue(verifyReturns),
    cnameTarget: jest.fn().mockReturnValue('custom.joingrowthproject.com'),
    checkTxt: jest.fn(),
    checkCnameOrA: jest.fn(),
    flyAnycastIps: jest.fn().mockReturnValue([]),
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('CoachDomainsService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let dns: ReturnType<typeof makeDns>;
  let svc: CoachDomainsService;

  beforeEach(() => {
    prisma = makePrisma();
    dns = makeDns();
    svc = new CoachDomainsService(prisma as any, dns as any);
  });

  describe('create', () => {
    beforeEach(() => {
      prisma._pages.push({ id: 'page-1', coach_id: 'coach-1', slug: 'pg', status: 'published' });
      prisma._subs.push({ coach_id: 'coach-1', tier: 'pro', status: 'active' });
    });

    it('issues a token and returns summary + instructions', async () => {
      const out = await svc.create('coach-1', 'page-1', 'coaching.example.com');
      expect(out.summary.domain).toBe('coaching.example.com');
      expect(out.summary.verification_status).toBe('pending');
      expect(out.instructions.dns_records).toHaveLength(2);
      expect(out.instructions.dns_records[0]).toMatchObject({
        type: 'TXT',
        host: '_tgp-verify.coaching.example.com',
      });
      // 32-byte hex token in the TXT value.
      expect(out.instructions.dns_records[0].value).toMatch(/^tgp-verify=[0-9a-f]{64}$/);
      expect(out.instructions.dns_records[1]).toMatchObject({
        type: 'CNAME',
        host: 'coaching.example.com',
        value: 'custom.joingrowthproject.com',
      });
      expect(prisma._domains).toHaveLength(1);
    });

    it('rejects free tier with 403 + upgrade_to=pro', async () => {
      prisma._subs[0].tier = 'free';
      try {
        await svc.create('coach-1', 'page-1', 'coaching.example.com');
        fail('expected ForbiddenException');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        expect((err as ForbiddenException).getResponse()).toMatchObject({
          error: 'tier_required',
          upgrade_to: 'pro',
        });
      }
    });

    it('accepts enterprise tier', async () => {
      prisma._subs[0].tier = 'enterprise';
      const out = await svc.create('coach-1', 'page-1', 'coaching.example.com');
      expect(out.summary.domain).toBe('coaching.example.com');
    });

    it('rejects invalid hostname with INVALID_DOMAIN', async () => {
      await expect(
        svc.create('coach-1', 'page-1', 'https://example.com/path'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects page not owned by coach', async () => {
      await expect(
        svc.create('coach-2', 'page-1', 'coaching.example.com'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects duplicate domain (P2002)', async () => {
      await svc.create('coach-1', 'page-1', 'coaching.example.com');
      await expect(
        svc.create('coach-1', 'page-1', 'coaching.example.com'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('accepts owner role (no subscription row)', async () => {
      // Owners typically have no CoachSubscription — the tier check
      // must still pass when the global @Roles guard already let them
      // through.  Today the service treats no-sub as tier=free, which
      // BLOCKS owners.  That is a known follow-up; this spec
      // documents current behavior so a future fix is intentional.
      prisma._subs.length = 0;
      await expect(
        svc.create('coach-1', 'page-1', 'coaching.example.com'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('listForPage', () => {
    it('returns rows scoped to coach + page only', async () => {
      prisma._pages.push(
        { id: 'page-1', coach_id: 'coach-1', slug: 'a', status: 'published' },
        { id: 'page-2', coach_id: 'coach-1', slug: 'b', status: 'published' },
      );
      prisma._subs.push({ coach_id: 'coach-1', tier: 'pro' });
      await svc.create('coach-1', 'page-1', 'a.example.com');
      await svc.create('coach-1', 'page-2', 'b.example.com');
      const list = await svc.listForPage('coach-1', 'page-1');
      expect(list).toHaveLength(1);
      expect(list[0].domain).toBe('a.example.com');
    });

    it('rejects when coach does not own the page', async () => {
      prisma._pages.push({ id: 'page-1', coach_id: 'coach-1' });
      await expect(svc.listForPage('coach-2', 'page-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('verifyNow', () => {
    beforeEach(() => {
      prisma._pages.push({ id: 'page-1', coach_id: 'coach-1' });
      prisma._subs.push({ coach_id: 'coach-1', tier: 'pro' });
    });

    it('flips pending → verified + cert_status=requested on success', async () => {
      const { summary } = await svc.create('coach-1', 'page-1', 'coaching.example.com');
      dns.verify.mockResolvedValueOnce({ verified: true });
      const out = await svc.verifyNow('coach-1', 'page-1', summary.id);
      expect(out.verification_status).toBe('verified');
      expect(out.cert_status).toBe('requested');
      expect(out.last_error).toBeNull();
    });

    it('persists reason on failure, leaves status pending', async () => {
      const { summary } = await svc.create('coach-1', 'page-1', 'coaching.example.com');
      dns.verify.mockResolvedValueOnce({ verified: false, reason: 'txt_missing' });
      const out = await svc.verifyNow('coach-1', 'page-1', summary.id);
      expect(out.verification_status).toBe('pending');
      expect(out.last_error).toBe('txt_missing');
    });

    it('no-ops when already verified', async () => {
      const { summary } = await svc.create('coach-1', 'page-1', 'coaching.example.com');
      // First call: success.
      dns.verify.mockResolvedValueOnce({ verified: true });
      await svc.verifyNow('coach-1', 'page-1', summary.id);
      const callsBefore = dns.verify.mock.calls.length;
      // Second call should NOT re-query DNS.
      const second = await svc.verifyNow('coach-1', 'page-1', summary.id);
      expect(dns.verify.mock.calls.length).toBe(callsBefore);
      expect(second.verification_status).toBe('verified');
    });
  });

  describe('revoke', () => {
    beforeEach(() => {
      prisma._pages.push({ id: 'page-1', coach_id: 'coach-1' });
      prisma._subs.push({ coach_id: 'coach-1', tier: 'pro' });
    });

    it('hard-deletes when no Fly cert exists', async () => {
      const { summary } = await svc.create('coach-1', 'page-1', 'coaching.example.com');
      const out = await svc.revoke('coach-1', 'page-1', summary.id);
      expect(out.flyTeardownPending).toBe(false);
      expect(prisma._domains).toHaveLength(0);
    });

    it('marks revoked (leaves row) when a Fly cert is provisioned', async () => {
      const { summary } = await svc.create('coach-1', 'page-1', 'coaching.example.com');
      prisma._domains[0].fly_cert_id = 'fly-cert-1';
      prisma._domains[0].cert_status = 'issued';
      const out = await svc.revoke('coach-1', 'page-1', summary.id);
      expect(out.flyTeardownPending).toBe(true);
      expect(prisma._domains).toHaveLength(1);
      expect(prisma._domains[0].verification_status).toBe('revoked');
    });
  });

  describe('worker callbacks', () => {
    beforeEach(() => {
      prisma._pages.push({ id: 'page-1', coach_id: 'coach-1' });
      prisma._subs.push({ coach_id: 'coach-1', tier: 'pro' });
    });

    it('recordCertResult ok=true populates fly_cert_id + expiry', async () => {
      const { summary } = await svc.create('coach-1', 'page-1', 'coaching.example.com');
      const expiry = new Date(Date.now() + 90 * 24 * 3600 * 1000);
      await svc.recordCertResult(summary.id, {
        ok: true,
        fly_cert_id: 'fly-cert-1',
        expires_at: expiry,
      });
      const row = prisma._domains[0];
      expect(row.cert_status).toBe('issued');
      expect(row.fly_cert_id).toBe('fly-cert-1');
      expect(row.cert_expires_at).toEqual(expiry);
      expect(row.last_error).toBeNull();
    });

    it('recordCertResult ok=false flips to failed (default) or expired (markExpired)', async () => {
      const { summary } = await svc.create('coach-1', 'page-1', 'coaching.example.com');
      await svc.recordCertResult(summary.id, { ok: false, reason: 'fly_AddCert:401' });
      expect(prisma._domains[0].cert_status).toBe('failed');
      expect(prisma._domains[0].last_error).toBe('fly_AddCert:401');

      await svc.recordCertResult(summary.id, {
        ok: false,
        reason: 'expired_state:Awaiting',
        markExpired: true,
      });
      expect(prisma._domains[0].cert_status).toBe('expired');
    });

    it('recordDnsVerified flips status + cert_status=requested when previously none', async () => {
      const { summary } = await svc.create('coach-1', 'page-1', 'coaching.example.com');
      await svc.recordDnsVerified(summary.id);
      expect(prisma._domains[0].verification_status).toBe('verified');
      expect(prisma._domains[0].cert_status).toBe('requested');
    });

    it('claimWorkerBatch returns pending rows', async () => {
      const { summary } = await svc.create('coach-1', 'page-1', 'coaching.example.com');
      const batch = await svc.claimWorkerBatch(10, new Date());
      expect(batch.map((r) => r.id)).toContain(summary.id);
    });

    it('claimWorkerBatch returns near-expiry issued rows', async () => {
      const { summary } = await svc.create('coach-1', 'page-1', 'coaching.example.com');
      // Mark issued + expires in 7 days (inside the 14-day renewal window).
      prisma._domains[0].verification_status = 'verified';
      prisma._domains[0].cert_status = 'issued';
      prisma._domains[0].cert_expires_at = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      const batch = await svc.claimWorkerBatch(10, new Date());
      expect(batch.map((r) => r.id)).toContain(summary.id);
    });

    it('claimWorkerBatch skips issued rows expiring beyond 14 days', async () => {
      const { summary } = await svc.create('coach-1', 'page-1', 'coaching.example.com');
      prisma._domains[0].verification_status = 'verified';
      prisma._domains[0].cert_status = 'issued';
      prisma._domains[0].cert_expires_at = new Date(Date.now() + 30 * 24 * 3600 * 1000);
      const batch = await svc.claimWorkerBatch(10, new Date());
      expect(batch.map((r) => r.id)).not.toContain(summary.id);
    });
  });

  describe('resolveByHost', () => {
    it('returns the row when verified + issued', async () => {
      prisma._pages.push({ id: 'page-1', coach_id: 'coach-1', slug: 'pg', status: 'published' });
      prisma._subs.push({ coach_id: 'coach-1', tier: 'pro' });
      const { summary } = await svc.create('coach-1', 'page-1', 'coaching.example.com');
      prisma._domains[0].verification_status = 'verified';
      prisma._domains[0].cert_status = 'issued';
      const out = await svc.resolveByHost('coaching.example.com');
      expect(out?.domain.id).toBe(summary.id);
      expect(out?.landing_page.slug).toBe('pg');
    });

    it('returns null when verification is pending', async () => {
      prisma._pages.push({ id: 'page-1', coach_id: 'coach-1', slug: 'pg', status: 'published' });
      prisma._subs.push({ coach_id: 'coach-1', tier: 'pro' });
      await svc.create('coach-1', 'page-1', 'coaching.example.com');
      const out = await svc.resolveByHost('coaching.example.com');
      expect(out).toBeNull();
    });

    it('returns null for unknown host', async () => {
      const out = await svc.resolveByHost('unknown.example.com');
      expect(out).toBeNull();
    });
  });
});

// ─── rollupStatus ────────────────────────────────────────────────────────────

describe('rollupStatus', () => {
  it.each([
    [{ verification_status: 'pending', cert_status: 'none' }, 'pending'],
    [{ verification_status: 'failed', cert_status: 'none' }, 'failed'],
    [{ verification_status: 'revoked', cert_status: 'issued' }, 'revoked'],
    [{ verification_status: 'verified', cert_status: 'requested' }, 'issuing'],
    [{ verification_status: 'verified', cert_status: 'issued' }, 'live'],
    [{ verification_status: 'verified', cert_status: 'failed' }, 'failed'],
    [{ verification_status: 'verified', cert_status: 'expired' }, 'failed'],
  ])('%j → %s', (row, expected) => {
    expect(rollupStatus(row as any)).toBe(expected);
  });
});
