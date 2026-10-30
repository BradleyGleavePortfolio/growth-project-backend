/**
 * LO-1185 B-TEST B2 (b#1185 round 1, Claude Opus lens): the behavior table's in-memory double must answer the SQL it
 * is given. rowsByAuthorsWhoStay (src/community/community-space-access.ts) is the one place every place read applies
 * the community ban (`AND app.community_author_unbanned(...)`). At 5ca78135 InMemoryPrisma.$queryRaw matches the SQL
 * on 'app.community_author_stays' and authorGone() applies the ban itself, so deleting the ban line from the real query
 * leaves the KT-2 behavior table green (lens run 40979239858). Red at 5ca78135: the double hides a banned author the
 * query never asked about.
 */
import 'reflect-metadata';
import { accessWorld } from './member-content-fixture';

describe('LO-1185 B2: the in-memory double applies only the rules the SQL asks for', () => {
  it('a stays-only query (no app.community_author_unbanned) keeps a banned author who stays', async () => {
    const w = await accessWorld();
    const author = w.member('Banned Stayer');
    w.db.seed('communityWorkspaceBan', { workspace_id: w.wsId, user_id: author.id, lifted_at: null });
    const kept = await w.db.$queryRaw`
      SELECT (t."n" - 1)::int AS "n"
      FROM unnest(${[w.wsId]}::uuid[], ${[w.cohortId]}::text[], ${[author.id]}::text[]) WITH ORDINALITY AS t("w", "s", "a", "n")
      WHERE app.community_author_stays(t."w", NULLIF(t."s", '')::uuid, t."a")`;
    expect(kept).toEqual([{ n: 0 }]);
  });

  it('the same query with the ban line drops the banned author (the control for the case above)', async () => {
    const w = await accessWorld();
    const author = w.member('Banned Stayer');
    w.db.seed('communityWorkspaceBan', { workspace_id: w.wsId, user_id: author.id, lifted_at: null });
    const kept = await w.db.$queryRaw`
      SELECT (t."n" - 1)::int AS "n"
      FROM unnest(${[w.wsId]}::uuid[], ${[w.cohortId]}::text[], ${[author.id]}::text[]) WITH ORDINALITY AS t("w", "s", "a", "n")
      WHERE app.community_author_stays(t."w", NULLIF(t."s", '')::uuid, t."a")
        AND app.community_author_unbanned(t."w", t."a")`;
    expect(kept).toEqual([]);
  });
});
