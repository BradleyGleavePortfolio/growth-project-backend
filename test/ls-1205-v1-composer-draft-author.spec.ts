/**
 * LS-1205 B5: the actual getThread response includes a shared composer draft,
 * not just CoachMessage rows. Words autosaved by a team coach must disappear
 * from the head's thread and resume-draft responses after either block.
 */
import { randomUUID } from 'crypto';
import { V1CoachService } from '../src/v1/v1-coach.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { ls1197Database } from './ls-1197-live-fixture';
import { stub } from './utils/trial-fakes';

describe('LS-1205 B5: v1 composer draft retains the actual coach author boundary', () => {
  let fixture: Awaited<ReturnType<typeof ls1197Database>>;
  let service: V1CoachService;
  const head = randomUUID();
  const team = randomUUID();
  const client = randomUUID();
  const teamWords = 'LS1205 team coach autosaved these private draft words';
  const headCaller = { id: head, role: 'coach' as const };
  const teamCaller = { id: team, role: 'coach' as const };

  beforeAll(async () => {
    fixture = await ls1197Database();
    for (const [id, role, coach_id] of [
      [head, 'coach', null], [team, 'coach', head], [client, 'student', head],
    ] as const) {
      await fixture.prisma.user.create({
        data: { id, role, coach_id, name: 'LS1205 composer fixture', email: randomUUID(), supabase_id: randomUUID() },
      });
    }
    await fixture.prisma.subCoachAssignment.create({
      data: { head_coach_id: head, sub_coach_id: team, client_id: client },
    });
    service = new V1CoachService(
      fixture.db, stub({}), stub({}), new SubCoachScopeService(fixture.db),
    );
  }, 240_000);
  afterEach(async () => {
    await fixture.prisma.userBlock.deleteMany({});
    await fixture.prisma.messageDraft.deleteMany({});
  });
  afterAll(async () => { await fixture?.stop(); });

  const cases: [string, 'thread' | 'resume'][] = [];
  for (const direction of ['head blocks team', 'team blocks head', 'no block']) {
    for (const surface of ['thread', 'resume'] as const) cases.push([direction, surface]);
  }
  it.each(cases)('%s / %s', async (direction, surface) => {
    // Do not fabricate a draft row: write it through the authorized autosave.
    await service.saveDraft(teamCaller, client, teamWords);
    expect(JSON.stringify(await service.getThread(headCaller, client))).toContain(teamWords);
    if (direction !== 'no block') {
      const [blocker_id, blocked_id] = direction === 'head blocks team' ? [head, team] : [team, head];
      await fixture.prisma.userBlock.create({ data: { blocker_id, blocked_id } });
    }
    const response = surface === 'thread'
      ? await service.getThread(headCaller, client) : await service.getDraft(headCaller, client);
    if (direction === 'no block') expect(JSON.stringify(response)).toContain(teamWords);
    else expect(JSON.stringify(response)).not.toContain(teamWords);
  }, 120_000);
});
