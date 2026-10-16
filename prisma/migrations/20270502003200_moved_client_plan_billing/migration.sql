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
-- 2. One chain rule, app.client_coach_chain(client, coach): the coaches who
--    own a client whose coach_id is `coach` (owner TM-M1 note: the coach, the
--    head coach of a seated sub-coach, a sub-coach holding an open delegation
--    of the client from that coach). In the move's own transaction, a move
--    stamps the client's purchases whose seller was in the old chain and is
--    not in the new one. Two kinds of move:
--    a. trg_user_coach_move_marks_plans: a client's coach_id changes, by any
--       path (reassign, sub-coach revoke or seat removal, support, coachless);
--    b. trg_delegation_end_marks_plans: a live delegation ends, changes or is
--       deleted while coach_id stays (S1 -> S2, or back to the head). Deferred
--       to commit, so the chain the transaction leaves decides (closing S's
--       delegation and making S the client's coach stamps nothing).
--    So A -> B stamps A's plans; inside H's team (H -> S, S -> H, S -> S2) H's
--    plans keep renewing (H still owns the client; owner decision MOVE-TEAM
--    pending) and S's are stamped when the client leaves S; a storefront
--    seller never in the chain is never stamped. On "User" only clients (role
--    student) count. All three functions are SECURITY INVOKER with a pinned
--    search_path: they run as the role that made the move (the server's role
--    bypasses RLS) and grant nothing. ClientPurchase policies are unchanged.

SET lock_timeout = '5s';

ALTER TABLE "ClientPurchase" ADD COLUMN "moved_away_at" TIMESTAMP(3);
CREATE INDEX "ClientPurchase_moved_away_at_idx" ON "ClientPurchase"("moved_away_at");

CREATE OR REPLACE FUNCTION app.client_coach_chain(p_client text, p_coach text)
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT p_coach WHERE p_coach IS NOT NULL
  UNION
  SELECT s."head_coach_id" FROM public."TeamSubCoachAssignment" s
   WHERE s."sub_coach_id" = p_coach AND s."archived_at" IS NULL
  UNION
  SELECT d."sub_coach_id" FROM public."SubCoachAssignment" d
   WHERE d."client_id" = p_client AND d."head_coach_id" = p_coach AND d."unassigned_at" IS NULL
$function$;

REVOKE ALL ON FUNCTION app.client_coach_chain(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.client_coach_chain(text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.user_coach_move_marks_plans()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  UPDATE public."ClientPurchase" cp
     SET "moved_away_at" = now()
   WHERE cp."client_user_id" = NEW."id"
     AND cp."moved_away_at" IS NULL
     AND cp."coach_user_id" IN (SELECT app.client_coach_chain(NEW."id", OLD."coach_id"))
     AND cp."coach_user_id" NOT IN (SELECT app.client_coach_chain(NEW."id", NEW."coach_id"));
  RETURN NULL;
END
$function$;

REVOKE ALL ON FUNCTION public.user_coach_move_marks_plans() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.user_coach_move_marks_plans() IS
  'MOVEBILL (MOVE-BILLING / MOVE-LTV option 1): on a change of a client''s coach_id, stamps ClientPurchase.moved_away_at on that client''s purchases sold by a coach in the old chain who is not in the new chain (app.client_coach_chain).';

CREATE TRIGGER trg_user_coach_move_marks_plans
  AFTER UPDATE OF "coach_id" ON "User"
  FOR EACH ROW
  WHEN (OLD."coach_id" IS DISTINCT FROM NEW."coach_id" AND NEW."role" = 'student')
  EXECUTE FUNCTION public.user_coach_move_marks_plans();

CREATE OR REPLACE FUNCTION public.delegation_end_marks_plans()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  UPDATE public."ClientPurchase" cp
     SET "moved_away_at" = now()
   WHERE cp."client_user_id" = OLD."client_id"
     AND cp."coach_user_id" = OLD."sub_coach_id"
     AND cp."moved_away_at" IS NULL
     AND cp."coach_user_id" NOT IN (
       SELECT c FROM public."User" u, app.client_coach_chain(u."id", u."coach_id") c
        WHERE u."id" = OLD."client_id");
  RETURN NULL;
END
$function$;

REVOKE ALL ON FUNCTION public.delegation_end_marks_plans() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.delegation_end_marks_plans() IS
  'MOVEBILL: when a live delegation ends, changes or is deleted, stamps ClientPurchase.moved_away_at on that client''s purchases sold by the delegated sub-coach if, at commit, they are no longer in the client''s chain (app.client_coach_chain).';

CREATE CONSTRAINT TRIGGER trg_delegation_end_marks_plans
  AFTER UPDATE OF "unassigned_at", "sub_coach_id", "head_coach_id", "client_id" OR DELETE ON "SubCoachAssignment"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD."unassigned_at" IS NULL)
  EXECUTE FUNCTION public.delegation_end_marks_plans();

RESET lock_timeout;
