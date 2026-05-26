/**
 * R49 E2E happy path: create → DNS verify → cert issued → SNI resolves.
 *
 * Uses the same in-memory Prisma stub as the unit spec but wires
 * CoachDomainsService + DomainCertProcessor + LandingPageHostMiddleware
 * together to walk a single domain through the full lifecycle.
 */

import { CoachDomainsService } from '../src/landing-pages/domains/domains.service';
import { DomainCertProcessor } from '../src/landing-pages/domains/cert.processor';
import { LandingPageHostMiddleware } from '../src/landing-pages/domains/host-routing.middleware';

function makePrisma() {
  const pages: any[] = [];
  const domains: any[] = [];
  const subs: any[] = [];
  const profiles: any[] = [];
  return {
    _pages: pages,
    _domains: domains,
    _subs: subs,
    _profiles: profiles,
    coachLandingPage: {
      findFirst: jest.fn(async ({ where }: any) =>
        pages.find((p) => p.id === where.id && (!where.coach_id || p.coach_id === where.coach_id)) ?? null,
      ),
    },
    coachSubscription: {
      findFirst: jest.fn(async ({ where }: any) =>
        subs.find((s) => s.coach_id === where.coach_id) ?? null,
      ),
    },
    coachProfile: {
      findFirst: jest.fn(async ({ where }: any) =>
        profiles.find((p) => p.coach_id === where.coach_id) ?? null,
      ),
    },
    coachLandingPageDomain: {
      create: jest.fn(async ({ data }: any) => {
        if (domains.some((d) => d.domain === data.domain)) {
          const err = new Error('P2002');
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
      findMany: jest.fn(async ({ where }: any) => {
        return domains.filter((d) => {
          if (!where?.OR) {
            if (where?.landing_page_id && d.landing_page_id !== where.landing_page_id) return false;
            if (where?.coach_id && d.coach_id !== where.coach_id) return false;
            return true;
          }
          return where.OR.some((c: any) => {
            for (const [k, v] of Object.entries(c)) {
              if (v && typeof v === 'object' && 'lte' in (v as any)) {
                if (!(d[k] instanceof Date)) return false;
                if (d[k].getTime() > (v as any).lte.getTime()) return false;
              } else if (v && typeof v === 'object' && 'not' in (v as any)) {
                if (d[k] === null || d[k] === (v as any).not) return false;
              } else if (d[k] !== v) {
                return false;
              }
            }
            return true;
          });
        });
      }),
      findUnique: jest.fn(async ({ where, include, select }: any) => {
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
          const out: any = {};
          for (const k of Object.keys(select)) out[k] = row[k];
          return out;
        }
        return row;
      }),
      findFirst: jest.fn(async ({ where }: any) =>
        domains.find((d) => Object.entries(where).every(([k, v]) => d[k] === v)) ?? null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const idx = domains.findIndex((d) => d.id === where.id);
        if (idx === -1) throw new Error('not found');
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

function makeDns(verified = true) {
  return {
    verify: jest.fn().mockResolvedValue({ verified }),
    cnameTarget: jest.fn().mockReturnValue('custom.joingrowthproject.com'),
    flyAnycastIps: jest.fn().mockReturnValue([]),
    checkTxt: jest.fn(),
    checkCnameOrA: jest.fn(),
  };
}

function makeFly() {
  return {
    isConfigured: jest.fn().mockReturnValue(true),
    addCertificate: jest.fn().mockResolvedValue({
      id: 'fly-cert-1',
      clientStatus: 'Ready',
      issuedExpiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
    }),
    getCertificate: jest.fn(),
    removeCertificate: jest.fn().mockResolvedValue(undefined),
  };
}

describe('R49 domain lifecycle — happy path', () => {
  it('walks create → verify → cert issued → SNI rewrite', async () => {
    const prisma = makePrisma();
    prisma._pages.push({
      id: 'page-1',
      coach_id: 'coach-1',
      slug: 'transform',
      status: 'published',
    });
    prisma._subs.push({ coach_id: 'coach-1', tier: 'pro', status: 'active' });
    prisma._profiles.push({ coach_id: 'coach-1', invite_code: 'GP-COACH1' });

    const dns = makeDns(true);
    const fly = makeFly();
    const svc = new CoachDomainsService(prisma as any, dns as any);
    const proc = new DomainCertProcessor(svc, dns as any, fly as any);
    const mw = new LandingPageHostMiddleware(svc);

    // 1. Coach creates the domain.
    const { summary, instructions } = await svc.create(
      'coach-1',
      'page-1',
      'coaching.example.com',
    );
    expect(summary.verification_status).toBe('pending');
    expect(instructions.dns_records).toHaveLength(2);

    // 2. Coach hits "verify now" — DNS resolver returns success.
    const afterVerify = await svc.verifyNow('coach-1', 'page-1', summary.id);
    expect(afterVerify.verification_status).toBe('verified');
    expect(afterVerify.cert_status).toBe('requested');

    // 3. Worker runs once — issues a cert.
    await proc.runOnce();
    expect(fly.addCertificate).toHaveBeenCalledWith('coaching.example.com');
    expect(prisma._domains[0].cert_status).toBe('issued');
    expect(prisma._domains[0].fly_cert_id).toBe('fly-cert-1');

    // 4. SNI middleware now rewrites GET / on the custom host.
    const req = { headers: { host: 'coaching.example.com' }, url: '/' } as any;
    const next = jest.fn();
    await mw.use(req, {} as any, next);
    expect(req.url).toBe('/p/GP-COACH1/transform');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('revoke flow tears down the Fly cert and drops the row', async () => {
    const prisma = makePrisma();
    prisma._pages.push({ id: 'page-1', coach_id: 'coach-1', slug: 's', status: 'published' });
    prisma._subs.push({ coach_id: 'coach-1', tier: 'pro' });

    const dns = makeDns(true);
    const fly = makeFly();
    const svc = new CoachDomainsService(prisma as any, dns as any);
    const proc = new DomainCertProcessor(svc, dns as any, fly as any);

    const { summary } = await svc.create('coach-1', 'page-1', 'r.example.com');
    // Pretend the cert was already issued.
    prisma._domains[0].verification_status = 'verified';
    prisma._domains[0].cert_status = 'issued';
    prisma._domains[0].fly_cert_id = 'fly-cert-X';
    prisma._domains[0].cert_expires_at = new Date(Date.now() + 60 * 24 * 3600 * 1000);

    const out = await svc.revoke('coach-1', 'page-1', summary.id);
    expect(out.flyTeardownPending).toBe(true);
    expect(prisma._domains[0].verification_status).toBe('revoked');

    await proc.runOnce();
    expect(fly.removeCertificate).toHaveBeenCalledWith('r.example.com');
    expect(prisma._domains).toHaveLength(0);
  });
});
