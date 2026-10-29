/**
 * Test-only fixture for member-content-access.spec.ts (KT-2 in KNOWN_TRAPS.md): one community with its coach,
 * a viewer, a control member everyone may see, and fresh authors the spec puts under one rule each (a block either
 * way, a ban, a departure, a removal). It reuses the in-memory Prisma double the community safety specs already
 * use (test/community/safety/in-memory-prisma.ts), which models the SQL rule readers (app.community_author_stays,
 * app.community_author_unbanned, app.community_can_access, authorsWhoLeft) over its tables. Nothing here changes
 * runtime code.
 */
import 'reflect-metadata';
import type { User } from '@prisma/client';
import { CommunityAccessService } from '../../../src/community/community-access.service';
import { CommunityPostsService } from '../../../src/community/posts/community-posts.service';
import { CommunityPostsRepository } from '../../../src/community/posts/community-posts.repository';
import { CommunityMessagesService } from '../../../src/community/messages/community-messages.service';
import { CommunityMessagesRepository } from '../../../src/community/messages/community-messages.repository';
import { CommunityDmsService } from '../../../src/community/dms/community-dms.service';
import { CommunityDmsRepository } from '../../../src/community/dms/community-dms.repository';
import { CommunitySafetyService } from '../../../src/community/safety/community-safety.service';
import { CommunityReactionsRepository } from '../../../src/community/reactions/community-reactions.repository';
import type { PrismaService } from '../../../src/prisma.service';
import type { CommunityRealtimeService } from '../../../src/community/realtime/community-realtime.service';
import type { CommunityNotificationsService } from '../../../src/community/notifications/community-notifications.service';
import type { PlanContextService } from '../../../src/community/plan-context/plan-context.service';
import { InMemoryPrisma } from '../safety/in-memory-prisma';

export type AccessRule =
  | 'blocked by the viewer'
  | 'has blocked the viewer'
  | 'banned from the community'
  | 'departed (moved to another coach)'
  | 'removed or deleted';

export const ACCESS_RULES: AccessRule[] = [
  'blocked by the viewer',
  'has blocked the viewer',
  'banned from the community',
  'departed (moved to another coach)',
  'removed or deleted',
];

/** The registry column (member-content-readers.ts) each rule is checked against. */
export const RULE_COLUMN: Record<AccessRule, 'block' | 'ban' | 'departed' | 'removed'> = {
  'blocked by the viewer': 'block',
  'has blocked the viewer': 'block',
  'banned from the community': 'ban',
  'departed (moved to another coach)': 'departed',
  'removed or deleted': 'removed',
};

function stub<T>(v: unknown): T {
  return v as T;
}

export interface AccessWorld {
  db: InMemoryPrisma;
  coach: User;
  viewer: User;
  control: User;
  wsId: string;
  cohortId: string;
  postId: string;
  safety: CommunitySafetyService;
  posts: CommunityPostsService;
  messages: CommunityMessagesService;
  dms: CommunityDmsService;
  /** A new member of the space, in good standing until a rule is applied. */
  member(name: string): User;
  /** Put `author` (and, for a removal, the row `rowId` in `table`) under `rule`, as seen by the viewer. */
  apply(rule: AccessRule, author: User, rowId?: { table: string; id: string }): Promise<void>;
}

export async function accessWorld(): Promise<AccessWorld> {
  const db = new InMemoryPrisma();
  const prisma = stub<PrismaService>(db);
  const seedUser = (role: string, name: string, coachId: string | null) =>
    stub<User>(db.seed('user', { role, name, deleted_at: null, coach_id: coachId }));
  const coach = seedUser('coach', 'Coach One', null);
  const otherCoach = seedUser('coach', 'Coach Two', null);
  const ws = db.seed('communityWorkspace', { coach_id: coach.id, name: 'Hall', dm_enabled_default: true, archived_at: null });
  const wsId = ws.id as string;
  const cohortId = db.seed('communityCohort', { workspace_id: wsId, name: 'Spring plan' }).id as string;
  const member = (name: string): User => {
    const u = seedUser('student', name, coach.id);
    db.seed('communityMembership', {
      workspace_id: wsId,
      cohort_id: cohortId,
      user_id: u.id,
      status: 'active',
      role: 'student',
      dm_enabled: null,
      removed_at: null,
    });
    return u;
  };
  const realtime = {
    channels: { cohort: () => 'cohort', workspace: () => 'workspace', user: () => 'user', moderation: () => 'moderation' },
    cohortShard: () => 0,
    broadcastCommunityEvent: async () => undefined,
  };
  const push = { pushEnabled: () => false, sendCommunityPush: async () => undefined };
  const access = new CommunityAccessService(prisma);
  const msgRepo = new CommunityMessagesRepository(prisma);
  const safety = new CommunitySafetyService(prisma);
  const rt = stub<CommunityRealtimeService>(realtime);
  const np = stub<CommunityNotificationsService>(push);
  const posts = new CommunityPostsService(
    access,
    new CommunityPostsRepository(prisma),
    msgRepo,
    rt,
    np,
    safety,
    new CommunityReactionsRepository(prisma),
  );
  const messages = new CommunityMessagesService(
    access,
    msgRepo,
    rt,
    stub<PlanContextService>({ validate: async () => null }),
    safety,
    np,
  );
  const dms = new CommunityDmsService(access, new CommunityDmsRepository(prisma), rt, np, safety);
  const viewer = member('Viewer Member');
  const control = member('Control Member');
  const post = await posts.create(coach, wsId, { title: 'Week one', body: 'Welcome' });

  const apply = async (rule: AccessRule, author: User, row?: { table: string; id: string }): Promise<void> => {
    switch (rule) {
      case 'blocked by the viewer':
        await safety.block(viewer, author.id);
        return;
      case 'has blocked the viewer':
        await safety.block(author, viewer.id);
        return;
      case 'banned from the community':
        db.seed('communityWorkspaceBan', { workspace_id: wsId, user_id: author.id, lifted_at: null });
        return;
      case 'departed (moved to another coach)':
        (author as { coach_id: string | null }).coach_id = otherCoach.id;
        return;
      case 'removed or deleted': {
        if (!row) throw new Error('accessWorld.apply: a removal needs the row');
        const hit = db.table(row.table).find((x) => x.id === row.id);
        if (!hit) throw new Error(`accessWorld.apply: no ${row.table} row ${row.id}`);
        hit.deleted_at = new Date();
        hit.removed_by_user_id = coach.id;
        return;
      }
    }
  };

  return { db, coach, viewer, control, wsId, cohortId, postId: post.post.id, safety, posts, messages, dms, member, apply };
}
