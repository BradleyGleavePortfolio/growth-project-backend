/**
 * Independent LS-1205R2 boundary proof. No sub-coach, shared assignment,
 * owner-written draft, device change, concurrency or timing race.
 */
import { randomUUID } from 'crypto';
import type { AuthedRequest } from '../src/auth/auth-request';
import { MessagesSafetyController } from '../src/messages-safety/messages-safety.controller';
import { MessagesSafetyService } from '../src/messages-safety/messages-safety.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { V1CoachService } from '../src/v1/v1-coach.service';
import { ls1197Database } from './ls-1197-live-fixture';
import { stub } from './utils/trial-fakes';

describe('LS-1205R2: a single coach resumes only their own autosave', () => {
  let fixture: Awaited<ReturnType<typeof ls1197Database>>;
  let v1: V1CoachService;
  let safety: MessagesSafetyController;
  const head = randomUUID();
  const client = randomUUID();
  const owner = randomUUID();
  const unrelated = randomUUID();
  const caller = { id: head, role: 'coach' as const };
  const cases = [
    { label: 'no block', blocker: null, blocked: null },
    { label: 'coach blocks unrelated coach', blocker: head, blocked: unrelated },
    { label: 'coach blocks platform owner', blocker: head, blocked: owner },
    { label: 'platform owner blocks coach', blocker: owner, blocked: head },
  ];

  beforeAll(async () => {
    fixture = await ls1197Database();
    for (const [id, role, coach_id] of [
      [head, 'coach', null], [client, 'student', head],
      [owner, 'owner', null], [unrelated, 'coach', null],
    ] as const) {
      await fixture.prisma.user.create({
        data: { id, role, coach_id, name: 'LS1205R2 solo', email: randomUUID(), supabase_id: randomUUID() },
      });
    }
    v1 = new V1CoachService(
      fixture.db, stub({}), stub({}), new SubCoachScopeService(fixture.db),
    );
    safety = new MessagesSafetyController(new MessagesSafetyService(
      fixture.db,
      stub({ write: jest.fn().mockResolvedValue(undefined) }),
      stub({ capture: jest.fn() }),
    ));
  }, 240_000);

  afterEach(async () => {
    await fixture.prisma.userBlock.deleteMany({});
    await fixture.prisma.messageDraft.deleteMany({});
  });
  afterAll(async () => { await fixture?.stop(); });

  for (const row of cases) {
    for (const when of ['after save', 'before save'] as const) {
      for (const reader of ['getDraft', 'getThread'] as const) {
        it(`${row.label} / ${when} / ${reader}: retain the sole coach's own words`, async () => {
          expect(await fixture.prisma.subCoachAssignment.count()).toBe(0);
          expect(await fixture.prisma.user.findUnique({
            where: { id: client }, select: { coach_id: true },
          })).toEqual({ coach_id: head });

          const initialWords = 'LS1205R2 initial solo coach autosave';
          await v1.saveDraft(caller, client, initialWords);
          expect(await v1.getDraft(caller, client)).toMatchObject({ body: initialWords });
          expect((await v1.getThread(caller, client)).draft).toMatchObject({ body: initialWords });

          if (row.blocker && row.blocked) {
            const req = stub<AuthedRequest>({
              user: { id: row.blocker, role: row.blocker === owner ? 'owner' : 'coach' },
            });
            const result = await safety.blockUser(req, row.blocked);
            expect(result.blockedUserId).toBe(row.blocked);
          }
          const expectedWords = when === 'before save'
            ? 'LS1205R2 fresh solo coach autosave after block'
            : initialWords;
          if (when === 'before save') {
            expect(await v1.saveDraft(caller, client, expectedWords)).toMatchObject({
              body: expectedWords, cleared: false,
            });
          }
          // Exactly one persisted draft, authored only by this ordinary coach.
          expect(await fixture.prisma.messageDraft.count()).toBe(1);
          expect(await fixture.prisma.messageDraft.findFirst({
            select: { coach_id: true, client_id: true, body: true },
          })).toEqual({ coach_id: head, client_id: client, body: expectedWords });

          const resumed = reader === 'getDraft'
            ? await v1.getDraft(caller, client)
            : (await v1.getThread(caller, client)).draft;
          expect(resumed).toMatchObject({ body: expectedWords });
        }, 120_000);
      }
    }
  }
});
