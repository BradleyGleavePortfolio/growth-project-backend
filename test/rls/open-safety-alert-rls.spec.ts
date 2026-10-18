/**
 * CRISIS-2B: open_safety_alert on GET /coach/clients/:id/summary, on the
 * replayed migration chain. The real CoachService on the superuser connection
 * (as the API runs), so the service rule decides; the same alert rows are also
 * read as the signed-in API role `authenticated` (no row-security bypass), a
 * control of 1 before each 0.
 * Fictional people, fresh ids per run: coaches K and L; S, K's sub-coach with
 * a seat and a delegation for A; O, the owner admin; client A of K, who moves
 * to L at the end; client C of L. A's alerts, all written to K: a dismissed
 * crisis alert, an open urgent one, the newest open crisis one, and a newer
 * open risk alert (not a Roman safety alert). C has an open eating-disorder
 * alert written to L.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import type { AuditService, AuditWriteInput } from '../../src/audit/audit.service';
import { CoachService } from '../../src/coach/coach.service';
import { ConsentService } from '../../src/consent/consent.service';
import { PrismaService } from '../../src/prisma.service';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('open-safety-alert-rls: CI=true but no TEST_DATABASE_URL; not skipping.');
}

(DB_URL ? describe : describe.skip)("CRISIS-2B: a client's open safety alert reaches their coach now and no one else", () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const stub = <T>(part: Partial<T>) => part as T;
  const audit = { write: jest.fn(async (_entry: AuditWriteInput) => undefined) };
  const service = new CoachService(
    prisma,
    stub<AuditService>(audit),
    new ConsentService(prisma, stub<AuditService>(audit)),
    new SubCoachScopeService(prisma),
  );
  const [K, L, S, O, A, C] = Array.from({ length: 6 }, () => randomUUID());
  const row: Record<string, { id: string; created_at: Date }> = {};

  const summary = (caller: string, client: string, role = 'coach') =>
    service.getClientSummary(caller, client, undefined, role) as Promise<Record<string, unknown>>;
  const openAlert = async (caller: string, client: string, role = 'coach') => {
    const out = await summary(caller, client, role);
    expect(out.client_name).toBe('Live person');
    return out.open_safety_alert;
  };
  const shown = (key: string, alert_type: string) => ({
    alert_id: row[key].id,
    alert_type,
    created_at: row[key].created_at,
  });
  /** The alert row as the signed-in API role, with app.current_user_id = who. */
  const seen = (who: string, key: string) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, 'coach');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: who }));
      return tx.coachAlert.count({ where: { id: row[key].id } });
    });

  beforeAll(async () => {
    for (const [id, role, coach_id] of [
      [K, 'coach', null], [L, 'coach', null], [S, 'coach', K], [O, 'owner', null],
      [A, 'student', K], [C, 'student', L],
    ] as const) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `crisis2b-${id}`, name: 'Live person', role, coach_id } });
    }
    await prisma.teamSubCoachAssignment.create({ data: { head_coach_id: K, sub_coach_id: S } });
    await prisma.subCoachAssignment.create({ data: { head_coach_id: K, sub_coach_id: S, client_id: A } });
    const seed: Array<[string, string, string, string, string, boolean]> = [
      ['aDismissed', A, K, 'roman_crisis_reply', '2026-10-17T09:00:00Z', true],
      ['aUrgent', A, K, 'roman_urgent_reply', '2026-10-17T09:30:00Z', false],
      ['aCrisis', A, K, 'roman_crisis_reply', '2026-10-17T10:00:00Z', false],
      ['aRisk', A, K, 'risk_red_transition', '2026-10-17T10:30:00Z', false],
      ['cEd', C, L, 'roman_eating_disorder_reply', '2026-10-17T11:00:00Z', false],
    ];
    for (const [key, client_id, coach_id, alert_type, at, dismissed] of seed) {
      row[key] = await prisma.coachAlert.create({
        data: {
          client_id, coach_id, alert_type, severity: 'critical', message: 'Live alert',
          created_at: new Date(at), acknowledged_at: dismissed ? new Date(at) : null,
        },
        select: { id: true, created_at: true },
      });
    }
  });
  afterAll(() => prisma.$disconnect());

  it('the API role used below does not bypass row security', async () => {
    const [{ b }] = await prisma.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = 'authenticated'`;
    expect(b).toBe(false);
  });

  it("K, A's coach: the newest open Roman safety alert, never a dismissed or a risk alert", async () => {
    expect(await openAlert(K, A)).toEqual(shown('aCrisis', 'roman_crisis_reply'));
    expect(await seen(K, 'aCrisis')).toBe(1);
  });

  it("L, another coach: A's summary is not found and the alert row reads 0; L's own client is unchanged", async () => {
    expect(await summary(L, A)).toEqual({ error: 'Client not found' });
    expect(await seen(K, 'aCrisis')).toBe(1);
    expect(await seen(L, 'aCrisis')).toBe(0);
    expect(await openAlert(L, C)).toEqual(shown('cEd', 'roman_eating_disorder_reply'));
    expect(await summary(K, C)).toEqual({ error: 'Client not found' });
    expect(await seen(L, 'cEd')).toBe(1);
    expect(await seen(K, 'cEd')).toBe(0);
  });

  it("K's sub-coach and the owner read A's summary with no alert in it", async () => {
    expect(await openAlert(S, A)).toBeNull();
    expect(await openAlert(O, A, 'owner')).toBeNull();
  });

  it('K dismisses the crisis alert: the open urgent one shows next', async () => {
    await prisma.coachAlert.update({ where: { id: row.aCrisis.id }, data: { acknowledged_at: new Date() } });
    expect(await openAlert(K, A)).toEqual(shown('aUrgent', 'roman_urgent_reply'));
  });

  it("A moves to L: K's summary is not found and K reads 0; L does not get K's alerts", async () => {
    await prisma.user.update({ where: { id: A }, data: { coach_id: L } });
    expect(await summary(K, A)).toEqual({ error: 'Client not found' });
    expect(await seen(L, 'aUrgent')).toBe(1);
    expect(await seen(K, 'aUrgent')).toBe(0);
    expect(await openAlert(L, A)).toBeNull();
  });
});
