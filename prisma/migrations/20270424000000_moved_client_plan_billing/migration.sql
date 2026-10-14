-- MOVEBILL (agent 143) — owner rulings MOVE-BILLING option 1 and MOVE-LTV
-- option 1: when a client moves coach, the plans they bought from the coach
-- they left stop renewing (no new charges after the paid period, failed-payment
-- retries and emails stop at once, no refund), and from the move date the
-- client stops counting as active and in MRR in that coach's ltv-metrics.
--
-- Additive only. Reverse: down.sql (drops only what this file adds).
--
-- 1. ClientPurchase.moved_away_at — when the client moved away from the coach
--    who sold this purchase. NULL = never moved away (every row before this
--    migration). Read by the server: the billing reconciler turns renewal off
--    on stamped live subscriptions, the dunning senders send nothing for a
--    stamped purchase, and ltv-metrics drops stamped purchases from active
--    clients and MRR from the move date. Money already paid is untouched.
--
-- 2. Trigger trg_user_coach_move_marks_plans on "User": a move is a change of
--    a client's coach_id, by any path (a head coach's reassign, a sub-coach
--    revoke or removal, support changing a client's coach, a client left
--    coachless). In the same transaction as the move it stamps the client's
--    purchases whose seller was in the client's old chain of coaches and is
--    not in the new one (owner TM-M1 note: one chain — the coach, plus the
--    head coach of a seated sub-coach, plus a sub-coach holding an open
--    delegation of the client). So:
--      * independent coach A -> coach B: A's plans are stamped;
--      * head coach H -> H's sub-coach S, or S -> H, or S -> S2 in H's team:
--        H's plans keep renewing (H still owns the client); S's are stamped
--        when the client leaves S;
--      * a plan the client bought from a coach who was never in their chain
--        (a storefront purchase) is never stamped by someone else's move.
--    Only clients (role student) are considered: a coach's own purchases as a
--    buyer are not affected by changes to that coach's coach_id.
--    SECURITY INVOKER with a pinned search_path: it runs with the privileges
--    of the role that changed coach_id (the server's role bypasses RLS);
--    it grants nothing. ClientPurchase policies are unchanged.

SET lock_timeout = '5s';

ALTER TABLE "ClientPurchase" ADD COLUMN "moved_away_at" TIMESTAMP(3);
CREATE INDEX "ClientPurchase_moved_away_at_idx" ON "ClientPurchase"("moved_away_at");

CREATE OR REPLACE FUNCTION public.user_coach_move_marks_plans()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  WITH chain(side, coach_id) AS (
    SELECT 'old', OLD."coach_id"
    UNION ALL
    SELECT 'old', s."head_coach_id" FROM public."TeamSubCoachAssignment" s
     WHERE s."sub_coach_id" = OLD."coach_id" AND s."archived_at" IS NULL
    UNION ALL
    SELECT 'old', d."sub_coach_id" FROM public."SubCoachAssignment" d
     WHERE d."client_id" = NEW."id" AND d."head_coach_id" = OLD."coach_id" AND d."unassigned_at" IS NULL
    UNION ALL
    SELECT 'new', NEW."coach_id"
    UNION ALL
    SELECT 'new', s."head_coach_id" FROM public."TeamSubCoachAssignment" s
     WHERE s."sub_coach_id" = NEW."coach_id" AND s."archived_at" IS NULL
    UNION ALL
    SELECT 'new', d."sub_coach_id" FROM public."SubCoachAssignment" d
     WHERE d."client_id" = NEW."id" AND d."head_coach_id" = NEW."coach_id" AND d."unassigned_at" IS NULL
  )
  UPDATE public."ClientPurchase" cp
     SET "moved_away_at" = now()
   WHERE cp."client_user_id" = NEW."id"
     AND cp."moved_away_at" IS NULL
     AND cp."coach_user_id" IN (SELECT c.coach_id FROM chain c WHERE c.side = 'old' AND c.coach_id IS NOT NULL)
     AND cp."coach_user_id" NOT IN (SELECT c.coach_id FROM chain c WHERE c.side = 'new' AND c.coach_id IS NOT NULL);
  RETURN NULL;
END
$function$;

REVOKE ALL ON FUNCTION public.user_coach_move_marks_plans() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.user_coach_move_marks_plans() IS
  'MOVEBILL (MOVE-BILLING / MOVE-LTV option 1): on a change of a client''s coach_id, stamps ClientPurchase.moved_away_at on that client''s purchases sold by a coach in the old chain (coach, seated sub-coach''s head, delegated sub-coach) who is not in the new chain.';

CREATE TRIGGER trg_user_coach_move_marks_plans
  AFTER UPDATE OF "coach_id" ON "User"
  FOR EACH ROW
  WHEN (OLD."coach_id" IS DISTINCT FROM NEW."coach_id" AND NEW."role" = 'student')
  EXECUTE FUNCTION public.user_coach_move_marks_plans();

RESET lock_timeout;
