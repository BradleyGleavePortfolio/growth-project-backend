import 'reflect-metadata';
import { PersonState } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CoachController } from '../../src/coach/coach.controller';
import {
  IMPORTED_PEOPLE_DEFAULT_PAGE_SIZE,
  IMPORTED_PEOPLE_HIDDEN_STATES,
  IMPORTED_PEOPLE_LABEL,
  IMPORTED_PEOPLE_MAX_PAGE_SIZE,
  IMPORTED_PEOPLE_MAX_SUGGESTIONS,
  ImportedPeopleQueryDto,
} from '../../src/coach/imported-people.dto';
import { ImportedPeopleService, normaliseName } from '../../src/coach/imported-people.service';
import {
  PERSON_LINK_BACKING_TABLES,
  inviteMarker,
  personLinkMarker,
  proposalMarker,
} from '../../src/coach/person-link-markers';
import { CoachService } from '../../src/coach/coach.service';
import { ROLES_KEY } from '../../src/common/decorators/roles.decorator';
import type { AdminPtmService } from '../../src/admin/ptm/admin-ptm.service';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import type { AuditService } from '../../src/audit/audit.service';
import type { AuthedRequest } from '../../src/auth/auth-request';
import type { ConsentService } from '../../src/consent/consent.service';
import type { PrismaService } from '../../src/prisma.service';

/**
 * S8-D2 — coach roster "imported, not yet joined" collection
 * (docs/decisions/2026-09-26-s8d-person-link.md §5.2). Unit specs over a fake
 * Prisma that records every call: tenant scope, the state filter, the emitted
 * field set (privacy), the truthful null markers, read-only suggestions and
 * bounded pagination. No PostgreSQL here; the RLS proof is the parent's lane.
 */

const COACH = '11111111-1111-4111-8111-111111111111';
const OTHER_COACH = '22222222-2222-4222-8222-222222222222';

interface PersonRow {
  id: string;
  coach_id: string;
  source_platform: string;
  source_person_id: string;
  display_name: string | null;
  state: PersonState;
  created_at: Date;
  updated_at: Date;
}
interface UserRow {
  id: string;
  coach_id: string | null;
  role: string;
  name: string;
  email: string;
  archived_at: Date | null;
}

class FakePrisma {
  readonly persons: PersonRow[] = [];
  readonly users: UserRow[] = [];
  readonly personCalls: any[] = [];
  readonly userCalls: any[] = [];

  readonly person = {
    findMany: async (args: any): Promise<Partial<PersonRow>[]> => {
      this.personCalls.push(args);
      const notIn: PersonState[] = args.where.state.notIn;
      let rows = this.persons
        .filter((p) => p.coach_id === args.where.coach_id && !notIn.includes(p.state))
        .sort((a, b) => {
          const t = b.created_at.getTime() - a.created_at.getTime();
          return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
      if (args.cursor) {
        const at = rows.findIndex((p) => p.id === args.cursor.id);
        if (at < 0) throw new Error('cursor row missing');
        rows = rows.slice(at + (args.skip ?? 0));
      }
      rows = rows.slice(0, args.take);
      return rows.map((p) => {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(args.select)) out[key] = p[key as keyof PersonRow];
        return out;
      });
    },
  };

  readonly user = {
    findMany: async (args: any): Promise<Partial<UserRow>[]> => {
      this.userCalls.push(args);
      const names: string[] = args.where.name.in.map((n: string) => n.toLowerCase());
      return this.users
        .filter(
          (u) =>
            u.coach_id === args.where.coach_id &&
            u.role === args.where.role &&
            u.archived_at === args.where.archived_at &&
            names.includes(u.name.toLowerCase()),
        )
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((u) => {
          const out: Record<string, unknown> = {};
          for (const key of Object.keys(args.select)) out[key] = u[key as keyof UserRow];
          return out;
        });
    },
  };
}

let seq = 0;
function person(fake: FakePrisma, over: Partial<PersonRow> = {}): PersonRow {
  seq += 1;
  const row: PersonRow = {
    id: `p-${String(seq).padStart(3, '0')}`,
    coach_id: COACH,
    source_platform: 'example-site',
    source_person_id: `tc_${seq}`,
    display_name: `Person ${seq}`,
    state: PersonState.InvitePending,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)),
    updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)),
    ...over,
  };
  fake.persons.push(row);
  return row;
}
function student(fake: FakePrisma, over: Partial<UserRow> = {}): UserRow {
  seq += 1;
  const row: UserRow = {
    id: `u-${String(seq).padStart(3, '0')}`,
    coach_id: COACH,
    role: 'student',
    name: `Student ${seq}`,
    email: `student-${seq}@synthetic.test`,
    archived_at: null,
    ...over,
  };
  fake.users.push(row);
  return row;
}
function makeService(fake: FakePrisma): ImportedPeopleService {
  return new ImportedPeopleService(fake as object as PrismaService);
}

const ROW_KEYS = [
  'display_name',
  'invite',
  'joined',
  'person_id',
  'proposal',
  'source_platform',
  'state',
  'suggestions',
].sort();

describe('ImportedPeopleService — tenant scope and state filter', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('reads only the calling coach id, hides Claimed and Deleted, shows Suspended with its state', async () => {
    const fake = new FakePrisma();
    const pending = person(fake);
    const invited = person(fake, { state: PersonState.Invited });
    const suspended = person(fake, { state: PersonState.Suspended });
    person(fake, { state: PersonState.Claimed });
    person(fake, { state: PersonState.Deleted });
    person(fake, { coach_id: OTHER_COACH });
    const res = await makeService(fake).list(COACH);

    expect(res.imported_people.map((p) => p.person_id)).toEqual([
      suspended.id,
      invited.id,
      pending.id,
    ]);
    expect(res.imported_people.map((p) => p.state)).toEqual([
      PersonState.Suspended,
      PersonState.Invited,
      PersonState.InvitePending,
    ]);
    expect(fake.personCalls).toHaveLength(1);
    expect(fake.personCalls[0].where).toEqual({
      coach_id: COACH,
      state: { notIn: [PersonState.Claimed, PersonState.Deleted] },
    });
    expect([...IMPORTED_PEOPLE_HIDDEN_STATES]).toEqual([PersonState.Claimed, PersonState.Deleted]);
  });

  it('never accepts a coach id from anywhere but the argument (no owner platform-wide read)', async () => {
    const fake = new FakePrisma();
    person(fake, { coach_id: OTHER_COACH });
    const res = await makeService(fake).list(COACH);
    expect(res.imported_people).toEqual([]);
    expect(fake.personCalls[0].where.coach_id).toBe(COACH);
    expect(fake.userCalls).toEqual([]);
  });
});

describe('ImportedPeopleService — emitted fields (privacy review)', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('selects exactly id, display_name, state, source_platform from Person and emits the §5.2 row', async () => {
    const fake = new FakePrisma();
    const p = person(fake, { display_name: 'Jordan Ellis' });
    const res = await makeService(fake).list(COACH);
    expect(Object.keys(fake.personCalls[0].select).sort()).toEqual(
      ['display_name', 'id', 'source_platform', 'state'].sort(),
    );
    expect(res.imported_people).toHaveLength(1);
    const row = res.imported_people[0];
    expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
    expect(row).toEqual({
      person_id: p.id,
      display_name: 'Jordan Ellis',
      state: PersonState.InvitePending,
      source_platform: 'example-site',
      joined: false,
      invite: null,
      proposal: null,
      suggestions: [],
    });
    // Never the source record id, never a contact field, never a User email.
    const json = JSON.stringify(res);
    expect(json).not.toContain('source_person_id');
    expect(json).not.toContain('tc_1');
    expect(json).not.toContain('email');
    expect(json).not.toContain('@');
    expect(Object.keys(res).sort()).toEqual(['imported_people', 'label', 'page']);
    expect(res.label).toBe(IMPORTED_PEOPLE_LABEL);
    expect(IMPORTED_PEOPLE_LABEL).toBe('imported, not yet joined');
  });

  it('a null display_name is emitted as null, not a placeholder', async () => {
    const fake = new FakePrisma();
    person(fake, { display_name: null });
    const res = await makeService(fake).list(COACH);
    expect(res.imported_people[0].display_name).toBeNull();
    expect(res.imported_people[0].suggestions).toEqual([]);
    // No name → no student lookup at all.
    expect(fake.userCalls).toEqual([]);
  });
});

describe('ImportedPeopleService — markers are truthful nulls (backing tables absent)', () => {
  it('declares every backing table absent and every resolver returns null', () => {
    expect(PERSON_LINK_BACKING_TABLES).toEqual({
      PersonLink: false,
      PersonInvite: false,
      PersonLinkProposal: false,
    });
    expect(personLinkMarker('u-1')).toBeNull();
    expect(inviteMarker('p-1')).toBeNull();
    expect(proposalMarker('p-1')).toBeNull();
  });

  it('emits invite: null and proposal: null on every row regardless of state', async () => {
    seq = 0;
    const fake = new FakePrisma();
    person(fake, { state: PersonState.Invited });
    person(fake, { state: PersonState.Suspended });
    person(fake);
    const res = await makeService(fake).list(COACH);
    expect(res.imported_people).toHaveLength(3);
    for (const row of res.imported_people) {
      expect(row.invite).toBeNull();
      expect(row.proposal).toBeNull();
      expect(row.joined).toBe(false);
    }
  });
});

describe('ImportedPeopleService — read-only suggestions', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('matches same-coach non-archived students by normalised name, bounded to the page names', async () => {
    const fake = new FakePrisma();
    const p = person(fake, { display_name: '  Jordan Ellis ' });
    const match = student(fake, { name: 'jordan ellis' });
    student(fake, { name: 'Jordan  Ellis' }); // inner whitespace differs: the DB pre-filter narrows it out
    student(fake, { name: 'Jordan Ellis', archived_at: new Date() }); // archived: excluded by the read
    student(fake, { name: 'Jordan Ellis', coach_id: OTHER_COACH }); // other coach: excluded by the read
    student(fake, { name: 'Jordan Ellis', role: 'coach' }); // not a student: excluded by the read
    student(fake, { name: 'Jordan Ellison' }); // near miss: never suggested
    const res = await makeService(fake).list(COACH);

    expect(res.imported_people[0].person_id).toBe(p.id);
    expect(res.imported_people[0].suggestions).toEqual([
      { user_id: match.id, display_name: 'jordan ellis' },
    ]);
    expect(fake.userCalls).toHaveLength(1);
    expect(fake.userCalls[0]).toEqual({
      where: {
        coach_id: COACH,
        role: 'student',
        archived_at: null,
        name: { in: ['Jordan Ellis'], mode: 'insensitive' },
      },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });
  });

  it('caps suggestions per Person, in id order, and shares one student across same-named Persons', async () => {
    const fake = new FakePrisma();
    const a = person(fake, { display_name: 'Sam Lee' });
    const b = person(fake, { display_name: 'sam lee' });
    const ids: string[] = [];
    for (let i = 0; i < IMPORTED_PEOPLE_MAX_SUGGESTIONS + 2; i += 1) {
      ids.push(student(fake, { name: 'Sam Lee' }).id);
    }
    const res = await makeService(fake).list(COACH);
    const byId = new Map(res.imported_people.map((r) => [r.person_id, r]));
    const expected = ids.sort().slice(0, IMPORTED_PEOPLE_MAX_SUGGESTIONS);
    expect(byId.get(a.id)?.suggestions.map((s) => s.user_id)).toEqual(expected);
    expect(byId.get(b.id)?.suggestions.map((s) => s.user_id)).toEqual(expected);
    // One bounded read for the whole page, not one per Person.
    expect(fake.userCalls).toHaveLength(1);
  });

  it('writes nothing: the fake exposes no create/update/upsert and none is reached', async () => {
    const fake = new FakePrisma();
    person(fake, { display_name: 'Sam Lee' });
    student(fake, { name: 'Sam Lee' });
    await makeService(fake).list(COACH);
    expect(Object.keys(fake.person)).toEqual(['findMany']);
    expect(Object.keys(fake.user)).toEqual(['findMany']);
  });

  it('normaliseName: trim, collapse whitespace, case-fold; empty → null', () => {
    expect(normaliseName('  Jordan   Ellis ')).toBe('jordan ellis');
    expect(normaliseName('JORDAN ELLIS')).toBe('jordan ellis');
    expect(normaliseName('   ')).toBeNull();
    expect(normaliseName('')).toBeNull();
    expect(normaliseName(null)).toBeNull();
    expect(normaliseName(undefined)).toBeNull();
  });
});

describe('ImportedPeopleService — bounded, deterministic pagination', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('defaults to the default page size and caps take at the ceiling', async () => {
    const fake = new FakePrisma();
    for (let i = 0; i < IMPORTED_PEOPLE_MAX_PAGE_SIZE + 5; i += 1) person(fake);
    const svc = makeService(fake);

    const d = await svc.list(COACH);
    expect(d.page).toEqual({
      limit: IMPORTED_PEOPLE_DEFAULT_PAGE_SIZE,
      next_cursor: d.imported_people[IMPORTED_PEOPLE_DEFAULT_PAGE_SIZE - 1].person_id,
      has_more: true,
    });
    expect(fake.personCalls[0].take).toBe(IMPORTED_PEOPLE_DEFAULT_PAGE_SIZE + 1);

    const capped = await svc.list(COACH, undefined, 999);
    expect(capped.page.limit).toBe(IMPORTED_PEOPLE_MAX_PAGE_SIZE);
    expect(capped.imported_people).toHaveLength(IMPORTED_PEOPLE_MAX_PAGE_SIZE);
    expect(capped.page.has_more).toBe(true);

    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const r = await svc.list(COACH, undefined, bad);
      expect(r.page.limit).toBe(IMPORTED_PEOPLE_DEFAULT_PAGE_SIZE);
    }
  });

  it('walks every row exactly once across pages, newest first, and ends with next_cursor null', async () => {
    const fake = new FakePrisma();
    const all: PersonRow[] = [];
    for (let i = 0; i < 7; i += 1) all.push(person(fake));
    const svc = makeService(fake);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const res = await svc.list(COACH, cursor, 3);
      pages += 1;
      seen.push(...res.imported_people.map((p) => p.person_id));
      if (!res.page.has_more) {
        expect(res.page.next_cursor).toBeNull();
        break;
      }
      expect(res.page.next_cursor).toBe(res.imported_people[2].person_id);
      cursor = res.page.next_cursor ?? undefined;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(all.map((p) => p.id).reverse());
    expect(fake.personCalls[1]).toMatchObject({ cursor: { id: seen[2] }, skip: 1, take: 4 });
    expect(fake.personCalls[0].orderBy).toEqual([{ created_at: 'desc' }, { id: 'asc' }]);
  });

  it('an empty roster is an empty page with the label still present', async () => {
    const fake = new FakePrisma();
    const res = await makeService(fake).list(COACH);
    expect(res).toEqual({
      imported_people: [],
      label: IMPORTED_PEOPLE_LABEL,
      page: { limit: IMPORTED_PEOPLE_DEFAULT_PAGE_SIZE, next_cursor: null, has_more: false },
    });
  });
});

describe('ImportedPeopleQueryDto validation', () => {
  async function errorsOf(input: Record<string, unknown>): Promise<string[]> {
    const dto = plainToInstance(ImportedPeopleQueryDto, input);
    return (await validate(dto)).map((e) => e.property);
  }

  it('accepts an empty query, a cursor and a take within range (numeric string coerced)', async () => {
    expect(await errorsOf({})).toEqual([]);
    expect(await errorsOf({ cursor: 'p-001', take: IMPORTED_PEOPLE_MAX_PAGE_SIZE })).toEqual([]);
    const dto = plainToInstance(ImportedPeopleQueryDto, { take: '25' });
    expect(await validate(dto)).toEqual([]);
    expect(dto.take).toBe(25);
  });

  it('rejects an oversized cursor and an out-of-range or non-integer take', async () => {
    expect(await errorsOf({ cursor: 'x'.repeat(65) })).toContain('cursor');
    expect(await errorsOf({ take: 0 })).toContain('take');
    expect(await errorsOf({ take: IMPORTED_PEOPLE_MAX_PAGE_SIZE + 1 })).toContain('take');
    expect(await errorsOf({ take: 1.5 })).toContain('take');
  });
});

describe('CoachController.getImportedPeople — role gate and delegation', () => {
  it('declares @Roles("coach", "owner") and the static clients/imported path', () => {
    const handler = CoachController.prototype.getImportedPeople;
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['coach', 'owner']);
    expect(Reflect.getMetadata('path', handler)).toBe('clients/imported');
  });

  it('passes only the bearer user id, cursor and take to the reader (no coach id from the query)', async () => {
    const list = jest.fn().mockResolvedValue({ imported_people: [], page: {} });
    const controller = new CoachController(
      {} as CoachService,
      {} as AnalyticsService,
      {} as AdminPtmService,
      { list } as object as ImportedPeopleService,
    );
    const req = { user: { id: COACH, role: 'coach' } } as object as AuthedRequest;
    await controller.getImportedPeople(req, { cursor: 'p-001', take: 10 });
    expect(list).toHaveBeenCalledWith(COACH, 'p-001', 10);
  });
});

describe('CoachService.getClients — S8-D2 person_link marker on client rows', () => {
  it('adds person_link: null to every row and changes nothing else about the array', async () => {
    const rows = [
      { id: 'u-1', name: 'A', profile: null },
      { id: 'u-2', name: 'B', profile: { id: 'pr-2' } },
    ];
    const prisma = { user: { findMany: jest.fn().mockResolvedValue(rows) } };
    const service = new CoachService(
      prisma as object as PrismaService,
      { write: jest.fn() } as object as AuditService,
      {} as ConsentService,
    );
    const out = await service.getClients('coach-1', 'active', 'coach');
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual([
      { id: 'u-1', name: 'A', profile: null, person_link: null },
      { id: 'u-2', name: 'B', profile: { id: 'pr-2' }, person_link: null },
    ]);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
  });
});
