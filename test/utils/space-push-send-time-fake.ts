// Sol B-2 (FR-1138): the reads the push worker makes for a space push at the moment of sending
// (src/community/space-push/space-push-still-due.ts), layered over a push outbox world's db
// (push-outbox-fake.ts). The lease claim ($queryRaw on "PushOutbox") still goes to that world.
type Msg = {
  id: string;
  workspace_id: string;
  cohort_id: string;
  sender_id: string;
  parent_message_id: string | null;
  high_alert: boolean;
  deleted_at?: Date | null;
};
type Where = Record<string, unknown>;

export function spaceAtSendTime(db: { $queryRaw: (sql: TemplateStringsArray, ...v: unknown[]) => unknown }, kind = 'announcement') {
  const s = {
    messages: [] as Msg[],
    blocks: [] as Array<{ blocker_id: string; blocked_id: string }>,
    /** active community bans: `${workspace}:${user}` (app.community_author_unbanned) */
    bans: new Set<string>(),
    /** people app.community_can_access refuses (not in the space, or banned from its community) */
    shut: new Set<string>(),
    reads: {} as Record<string, { notify_mode: string | null; silenced_until: Date | null; left_at?: Date | null }>,
    /** LEAVE-MUTE-PUSH: community_thread_prefs, `${user}:${first message}` -> 'muted' | 'left' */
    threads: {} as Record<string, string>,
    unread: 1,
    /** Sol B1 (FR-1138R5), app.community_author_stays: each client's coach now (the workspace's coach is 'coach').
     * A client on another coach has left the community, except in a public space or with a helper row there. */
    coachOf: { sam: 'coach' } as Record<string, string>,
    publicSpaces: new Set<string>(),
    helpers: new Set<string>(),
  };
  const stays = (w: string, c: string, a: string) =>
    (!(a in s.coachOf) || s.coachOf[a] === 'coach' || s.publicSpaces.has(c) || s.helpers.has(a)) && !s.bans.has(`${w}:${a}`);
  const matches = (m: Msg, w: Where) =>
    Object.entries(w).every(([k, v]) => (k === 'deleted_at' ? !m.deleted_at : (m as Record<string, unknown>)[k] === v || !(k in m)));
  const blocked = (o: { blocker_id: string; blocked_id: string }) =>
    s.blocks.some((b) => b.blocker_id === o.blocker_id && b.blocked_id === o.blocked_id);
  const overlay = {
    communityMessage: {
      findFirst: jest.fn(async ({ where }: { where: Where }) => s.messages.find((m) => matches(m, where)) ?? null),
    },
    userBlock: {
      count: jest.fn(async ({ where }: { where: { OR: Array<{ blocker_id: string; blocked_id: string }> } }) =>
        where.OR.filter(blocked).length,
      ),
    },
    communitySpaceRead: {
      findFirst: jest.fn(async ({ where }: { where: { user_id: string } }) => s.reads[where.user_id] ?? null),
    },
    communityCohort: { findUnique: jest.fn(async () => ({ kind })) },
    communityThreadPref: {
      findFirst: jest.fn(async ({ where }: { where: { user_id: string; thread_message_id: string } }) => {
        const state = s.threads[`${where.user_id}:${where.thread_message_id}`];
        return state ? { state } : null;
      }),
    },
    $queryRaw: jest.fn(async (sql: TemplateStringsArray, ...v: unknown[]) => {
      const text = sql.join('?');
      if (text.includes('community_can_access')) {
        const [spaces, people] = v as [string[], string[]];
        return spaces.map((c, i) => [c, people[i]]).filter(([, u]) => !s.shut.has(u)).map(([c, u]) => ({ k: `${c}:${u}` }));
      }
      if (text.includes('community_space_reads')) {
        return (v[v.length - 1] as string[]).map((c) => ({ c, n: s.unread }));
      }
      if (text.includes('community_author_stays')) {
        // rowsByAuthorsWhoStay: [workspaces, spaces, authors]; the 0-based places that still read.
        const [ws, spaces, authors] = v as [string[], string[], string[]];
        return authors.flatMap((a, n) => (stays(ws[n], spaces[n], a) ? [{ n }] : []));
      }
      return db.$queryRaw(sql, ...v);
    }),
  };
  return { s, db: Object.assign(Object.create(db), overlay) as typeof db & typeof overlay };
}
