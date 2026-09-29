/**
 * In-memory stand-in for the two `SELECT ... FOR SHARE` statements issued by
 * `src/sub-coach/tenancy-lock.ts` (D8 round 3, R593-c7A2-01), so unit specs that
 * drive the REAL SubCoachScopeService over a mocked Prisma client keep working.
 * Locking semantics are NOT modelled here (see the live-PG race tests in
 * test/rls-d8-service-role-assignment-writers.spec.ts); this only answers the
 * reads from the given store, and records that the read happened.
 */
export interface TenancyMockUser {
  id: string;
  role: string;
  coach_id?: string | null;
  deleted_at?: Date | null;
}

export interface TenancyMockStore {
  users: Iterable<TenancyMockUser>;
  subCoachAssignments: Iterable<{
    sub_coach_id: string;
    client_id: string;
    unassigned_at: Date | null;
  }>;
}

function sqlText(query: any): string {
  if (query && Array.isArray(query.strings)) return query.strings.join('?');
  if (query && typeof query.sql === 'string') return query.sql;
  return String(query);
}

/** Build a `$queryRaw` mock answering the tenancy-lock statements over `store`. */
export function tenancyQueryRawMock(store: TenancyMockStore) {
  return async (query: any, ..._rest: unknown[]) => {
    const text = sqlText(query);
    const values: unknown[] = Array.isArray(query?.values) ? query.values : [];
    if (text.includes('"SubCoachAssignment"')) {
      const [actor, client] = values as string[];
      return [...store.subCoachAssignments]
        .filter(
          (a) => a.sub_coach_id === actor && a.client_id === client && a.unassigned_at === null,
        )
        .map((_a, i) => ({ id: `sca-${i}` }));
    }
    if (text.includes('"User"')) {
      const ids = new Set(values as string[]);
      return [...store.users]
        .filter((u) => ids.has(u.id))
        .map((u) => ({
          id: u.id,
          role: u.role,
          coach_id: u.coach_id ?? null,
          deleted_at: u.deleted_at ?? null,
        }));
    }
    throw new Error(`tenancyQueryRawMock: unexpected raw query: ${text}`);
  };
}
