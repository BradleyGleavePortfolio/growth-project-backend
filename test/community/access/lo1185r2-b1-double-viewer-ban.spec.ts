/**
 * LO-1185R2 B-TEST B1 (b#1185 round 2, Claude Opus lens): the in-memory double applies a rule only when the SQL asks
 * for it (round 1 LO-1185 B2, closed in 49d50245 for rowsByAuthorsWhoStay and authorsWhoLeft). unbannedSpaces
 * (src/community/community-public-row.ts) is the one place the own-coach arm of rule D drops the public spaces of a
 * community that banned the reader (`WHERE app.community_author_unbanned(t."w", viewer)`). At b2c97643 the double's
 * `AS t("id", "w")` branch drops those spaces whatever the SQL says, so deleting that WHERE line leaves every suite on
 * the double green (lens bite run 41108676409). Red at b2c97643: the double hides a banned reader's space for a query
 * that never asked about the ban.
 */
import 'reflect-metadata';
import { accessWorld } from './member-content-fixture';

describe('LO-1185R2 B1: the double applies the reader ban only when the SQL asks for it', () => {
  it('an unbannedSpaces-shaped query without app.community_author_unbanned keeps the space of a banned reader', async () => {
    const w = await accessWorld();
    w.db.seed('communityWorkspaceBan', { workspace_id: w.wsId, user_id: w.coach.id, lifted_at: null });
    const rows = await w.db.$queryRaw`
      SELECT t."id"::text AS "id"
      FROM unnest(${[w.cohortId]}::uuid[], ${[w.wsId]}::uuid[]) AS t("id", "w")
      WHERE ${w.coach.id}::text IS NOT NULL`;
    expect(rows).toEqual([{ id: w.cohortId }]);
  });

  it('the same query with the ban line drops it (the control for the case above)', async () => {
    const w = await accessWorld();
    w.db.seed('communityWorkspaceBan', { workspace_id: w.wsId, user_id: w.coach.id, lifted_at: null });
    const rows = await w.db.$queryRaw`
      SELECT t."id"::text AS "id"
      FROM unnest(${[w.cohortId]}::uuid[], ${[w.wsId]}::uuid[]) AS t("id", "w")
      WHERE app.community_author_unbanned(t."w", ${w.coach.id})`;
    expect(rows).toEqual([]);
  });
});
