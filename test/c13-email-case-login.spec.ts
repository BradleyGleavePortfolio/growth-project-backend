import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service';
import { AuditService } from '../src/audit/audit.service';

// Sol B-597-1 — signup stores the canonical (lowercased, NFKC) address, so
// every password sign-in path must canonicalise the same way. A user who
// registers as `Jane@Example.com` must sign in with that exact spelling on
// BOTH /auth/login and /auth/extension/login, and legacy rows stored as typed
// (before C13) must keep working.
//
// Real AuthService; the only doubles are Supabase (which folds addresses to
// lowercase, like GoTrue) and an in-memory Prisma user table whose `email`
// unique lookup is case-SENSITIVE, like the real TEXT unique index.

type SupaUser = { id: string; email: string; password: string };
const mockSupabase: { users: SupaUser[]; signInCalls: string[] } = { users: [], signInCalls: [] };

jest.mock('@supabase/supabase-js', () => {
  const actual = jest.requireActual('@supabase/supabase-js');
  return {
    ...actual,
    createClient: jest.fn(() => ({
      auth: {
        signUp: async ({
          email,
          password,
          options,
        }: {
          email: string;
          password: string;
          options?: { data?: unknown };
        }) => {
          const folded = email.toLowerCase();
          let u = mockSupabase.users.find((x) => x.email === folded);
          if (!u) {
            u = { id: `sup-${mockSupabase.users.length + 1}`, email: folded, password };
            mockSupabase.users.push(u);
          }
          return {
            data: {
              user: {
                id: u.id,
                email: u.email,
                identities: [{ provider: 'email' }],
                user_metadata: options?.data,
              },
            },
            error: null,
          };
        },
        signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
          mockSupabase.signInCalls.push(email);
          const u = mockSupabase.users.find((x) => x.email === email.toLowerCase());
          if (!u || u.password !== password) {
            return {
              data: { session: null, user: null },
              error: { message: 'Invalid login credentials' },
            };
          }
          return {
            data: {
              session: { access_token: `at-${u.id}`, refresh_token: `rt-${u.id}` },
              user: { id: u.id },
            },
            error: null,
          };
        },
        admin: { deleteUser: jest.fn(), getUserById: jest.fn() },
      },
    })),
  };
});

type Row = {
  id: string;
  email: string;
  supabase_id: string | null;
  role: string;
  coach_id: string | null;
  name: string;
  created_at: Date;
  profile: null;
};

function buildPrisma(seed: Row[] = []) {
  const users: Row[] = [...seed];
  let seq = 0;
  const user = {
    findUnique: jest.fn(
      async ({ where }: { where: { email?: string; supabase_id?: string; id?: string } }) => {
        if (where.supabase_id !== undefined)
          return users.find((u) => u.supabase_id === where.supabase_id) ?? null;
        if (where.email !== undefined) return users.find((u) => u.email === where.email) ?? null; // case-SENSITIVE
        if (where.id !== undefined) return users.find((u) => u.id === where.id) ?? null;
        return null;
      },
    ),
    findFirst: jest.fn(
      async ({ where }: { where: { email?: { equals: string; mode?: string } } }) => {
        const cond = where.email;
        if (!cond) return null;
        const match = (u: Row) =>
          cond.mode === 'insensitive'
            ? u.email.toLowerCase() === cond.equals.toLowerCase()
            : u.email === cond.equals;
        return [...users].sort((a, b) => +a.created_at - +b.created_at).find(match) ?? null;
      },
    ),
    create: jest.fn(async ({ data }: { data: Partial<Row> }) => {
      if (users.some((u) => u.email === data.email)) throw new Error('P2002 email');
      const row: Row = {
        id: `u-${++seq}`,
        email: String(data.email),
        supabase_id: data.supabase_id ?? null,
        role: data.role ?? 'student',
        coach_id: null,
        name: data.name ?? '',
        created_at: new Date(),
        profile: null,
      };
      users.push(row);
      return row;
    }),
  };
  return {
    user,
    auditLog: { create: jest.fn(async () => ({})) },
    $executeRaw: jest.fn(async () => 1),
    _users: users,
  };
}

const cast = <T>(v: unknown): T => v as T;

function buildService(prisma: ReturnType<typeof buildPrisma>) {
  return new AuthService(
    cast(prisma),
    cast({}),
    cast({ capture: jest.fn(), identify: jest.fn() }),
    new AuditService(cast(prisma)),
    cast({}),
    cast({}),
  );
}

const PW = 'Aa1!aaaa';

beforeEach(() => {
  mockSupabase.users = [];
  mockSupabase.signInCalls = [];
});

describe('B-597-1 — mixed-case signup then sign-in', () => {
  it('register Jane@Example.com stores the canonical address', async () => {
    const prisma = buildPrisma();
    const service = buildService(prisma);
    const res = await service.register({ email: 'Jane@Example.com', password: PW, name: 'Jane' });
    expect(res.email).toBe('jane@example.com');
    expect(prisma._users[0].email).toBe('jane@example.com');
  });

  it.each([
    ['login', 'Jane@Example.com'],
    ['login', 'jane@example.com'],
    ['login', '  JANE@EXAMPLE.COM '],
    ['extensionLogin', 'Jane@Example.com'],
    ['extensionLogin', 'jane@example.com'],
    ['extensionLogin', 'JANE@example.COM'],
  ] as const)('%s with %p after a mixed-case signup succeeds', async (method, spelling) => {
    const prisma = buildPrisma();
    const service = buildService(prisma);
    const reg = await service.register({ email: 'Jane@Example.com', password: PW, name: 'Jane' });
    const out = await service[method](spelling, PW);
    expect(out.user.id).toBe(reg.user_id);
    expect(out.user.email).toBe('jane@example.com');
    // Supabase sees the canonical address too.
    expect(mockSupabase.signInCalls[mockSupabase.signInCalls.length - 1]).toBe('jane@example.com');
  });

  it('the local row is resolved by the VERIFIED Supabase id first, independent of spelling', async () => {
    const prisma = buildPrisma();
    const service = buildService(prisma);
    await service.register({ email: 'Jane@Example.com', password: PW, name: 'Jane' });
    prisma.user.findUnique.mockClear();
    await service.login('JANE@EXAMPLE.COM', PW);
    expect(prisma.user.findUnique.mock.calls[0][0]).toMatchObject({
      where: { supabase_id: 'sup-1' },
    });
  });

  it.each(['login', 'extensionLogin'] as const)(
    '%s: a legacy row stored as typed (Legacy@Example.com, no supabase_id match) still signs in with any spelling',
    async (method) => {
      mockSupabase.users.push({ id: 'sup-legacy', email: 'legacy@example.com', password: PW });
      const prisma = buildPrisma([
        {
          id: 'u-legacy',
          email: 'Legacy@Example.com',
          supabase_id: null,
          role: 'student',
          coach_id: null,
          name: 'L',
          created_at: new Date('2025-01-01'),
          profile: null,
        },
      ]);
      const service = buildService(prisma);
      for (const spelling of ['Legacy@Example.com', 'legacy@example.com']) {
        const out = await service[method](spelling, PW);
        expect(out.user.id).toBe('u-legacy');
      }
    },
  );

  it.each(['login', 'extensionLogin'] as const)(
    '%s: a wrong password is still a 401',
    async (method) => {
      const prisma = buildPrisma();
      const service = buildService(prisma);
      await service.register({ email: 'Jane@Example.com', password: PW, name: 'Jane' });
      await expect(service[method]('Jane@Example.com', 'Wrong1!x')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    },
  );

  it('a case variant of a registered address is still a duplicate at signup', async () => {
    const prisma = buildPrisma();
    const service = buildService(prisma);
    await service.register({ email: 'Jane@Example.com', password: PW, name: 'Jane' });
    await expect(
      service.register({ email: 'JANE@example.com', password: PW, name: 'J2' }),
    ).rejects.toThrow('Email already registered');
  });
});
