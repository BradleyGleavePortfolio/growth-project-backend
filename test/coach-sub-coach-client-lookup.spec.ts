import { Test, TestingModule } from '@nestjs/testing';
import { CoachService } from '../src/coach/coach.service';
import { PrismaService } from '../src/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { ConsentService } from '../src/consent/consent.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';

/**
 * B-878-SOL-I-131-1 (LN-SOL-I-131 @ 3ec27c47): a sub-coach's scope is
 * `{ id: { in: assignedIds } }`. Spread into `{ id: clientId, ...scope }` it
 * replaced the requested id, so the lookup found one of the sub-coach's own
 * clients and the write or read that followed used the requested id: a
 * sub-coach could archive, unarchive or read a client who is not assigned to
 * them. The fake below evaluates the real `where` (AND, equality, `in`)
 * instead of always answering null, so the scope is tested as Postgres sees it.
 */
type UserRow = { id: string; name: string; coach_id: string; role: string; archived_at: Date | null };
type Where = Record<string, unknown>;

function matches(row: UserRow, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    const cell = row[key as keyof UserRow];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const ops = Object.keys(cond);
      if (ops.length !== 1 || ops[0] !== 'in') throw new Error(`fake: unsupported where on ${key}: ${ops.join(',')}`);
      return ((cond as { in: unknown[] }).in).includes(cell);
    }
    return cell === cond;
  });
}

const HEAD = 'head-coach';
const SUB = 'sub-coach';

function makeRows(): UserRow[] {
  return [
    { id: 'mine', name: 'Assigned', coach_id: HEAD, role: 'student', archived_at: null },
    { id: 'theirs', name: 'Not assigned', coach_id: HEAD, role: 'student', archived_at: null },
    { id: 'theirs-archived', name: 'Not assigned, archived', coach_id: HEAD, role: 'student', archived_at: new Date('2026-10-01T00:00:00Z') },
  ];
}

describe('B-878-SOL-I-131-1 — a sub-coach reaches only the clients assigned to them', () => {
  let rows: UserRow[];
  let service: CoachService;
  let user: { findFirst: jest.Mock; update: jest.Mock };
  let audit: { write: jest.Mock };

  beforeEach(async () => {
    rows = makeRows();
    user = {
      findFirst: jest.fn(async ({ where }: { where: Where }) => {
        const row = rows.find((r) => matches(r, where));
        return row ? { ...row } : null;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('fake: user not found');
        Object.assign(row, data);
        return { ...row };
      }),
    };
    audit = { write: jest.fn(async () => undefined) };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        CoachService,
        { provide: PrismaService, useValue: { user } },
        { provide: AuditService, useValue: audit },
        { provide: ConsentService, useValue: { coachCanAccess: jest.fn(async () => true) } },
        {
          provide: SubCoachScopeService,
          useValue: {
            isSubCoach: jest.fn(async (id: string) => id === SUB),
            getAuthorizedClientIds: jest.fn(async () => ['mine']),
          },
        },
      ],
    }).compile();
    service = mod.get(CoachService);
  });

  it('Archive with an unassigned client id is refused and that client stays active', async () => {
    await expect(service.archiveClient(SUB, 'theirs', 'coach')).rejects.toThrow('Client not found');
    expect(user.update).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
    expect(rows.find((r) => r.id === 'theirs')?.archived_at).toBeNull();
  });

  it('Unarchive with an unassigned client id is refused and that client stays archived', async () => {
    await expect(service.unarchiveClient(SUB, 'theirs-archived', 'coach')).rejects.toThrow('Client not found');
    expect(user.update).not.toHaveBeenCalled();
    expect(rows.find((r) => r.id === 'theirs-archived')?.archived_at).not.toBeNull();
  });

  it('Timeline and Summary for an unassigned client id answer not found before any read', async () => {
    await expect(service.getClientTimeline(SUB, 'theirs', 90, 'coach')).resolves.toEqual({ error: 'Client not found' });
    await expect(service.getClientSummary(SUB, 'theirs', undefined, 'coach')).resolves.toEqual({ error: 'Client not found' });
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('the assigned client can still be archived by the sub-coach, and the head coach keeps the whole roster', async () => {
    await expect(service.archiveClient(SUB, 'mine', 'coach')).resolves.toMatchObject({ id: 'mine' });
    expect(rows.find((r) => r.id === 'mine')?.archived_at).not.toBeNull();
    await expect(service.archiveClient(HEAD, 'theirs', 'coach')).resolves.toMatchObject({ id: 'theirs' });
    expect(rows.find((r) => r.id === 'theirs')?.archived_at).not.toBeNull();
    // Another head coach's id never matches this roster.
    await expect(service.unarchiveClient('other-head', 'theirs', 'coach')).rejects.toThrow('Client not found');
  });
});
