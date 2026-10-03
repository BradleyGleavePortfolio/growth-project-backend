-- Catalog verifier for 20270306000000_message_photos (A6-PHOTOS).
--
-- Run by scripts/release.sh after `prisma migrate deploy` (listed in
-- scripts/release-required-verifiers.txt). Read-only. Same proof as the
-- data-exports verifier (B-EXPORT / A-636-1), for the `message-photos` bucket:
--   MISSING   the bucket does not exist, or storage.objects is missing while
--             storage.buckets exists.
--   EXPOSURE  the bucket is not private; it accepts types other than
--             JPEG/PNG/WebP; RLS is off on storage.objects; the restrictive
--             fence `message_photos_api_roles_fence` is missing or altered;
--             anon/authenticated escape RLS; or an RLS-escaping view over
--             storage.objects is selectable by them.
--   SERVICE   service_role does not bypass RLS (the fence would block the backend).
-- On a database without storage.buckets (CI, local dev) it reports a NOTICE
-- and passes: there is no Storage there to expose.
--
-- Usage (read-only):
--   psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 -f prisma/migrations/20270306000000_message_photos/verify.sql

DO $verify_message_photos_bucket$
DECLARE
  v_public boolean;
  v_objects regclass;
  v_owner oid;
  v_rls boolean;
  v_fence record;
  v_fence_count integer;
  v_expected text := '(bucket_id IS DISTINCT FROM ''message-photos''::text)';
  v_role text;
  v_view text;
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'message-photos verifier: storage.buckets not present (not a Supabase database); skipped.';
    RETURN;
  END IF;

  SELECT public INTO v_public FROM storage.buckets WHERE id = 'message-photos';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MISSING: storage bucket message-photos does not exist. Fix: re-apply the idempotent migration file with npx prisma db execute --url "$DIRECT_URL" --file prisma/migrations/20270306000000_message_photos/migration.sql, then re-run this verifier.';
  END IF;
  IF v_public IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'EXPOSURE: storage bucket message-photos is not private (public = %). Fix: re-apply the idempotent migration file with npx prisma db execute --url "$DIRECT_URL" --file prisma/migrations/20270306000000_message_photos/migration.sql, then re-run this verifier.', coalesce(v_public::text, 'null');
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'allowed_mime_types'
  ) AND EXISTS (
    SELECT 1 FROM storage.buckets
     WHERE id = 'message-photos'
       AND (allowed_mime_types IS NULL
            OR NOT (allowed_mime_types <@ ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]))
  ) THEN
    RAISE EXCEPTION 'EXPOSURE: storage bucket message-photos accepts types other than JPEG/PNG/WebP. Fix: re-apply the idempotent migration file with npx prisma db execute --url "$DIRECT_URL" --file prisma/migrations/20270306000000_message_photos/migration.sql, then re-run this verifier.';
  END IF;

  v_objects := to_regclass('storage.objects');
  IF v_objects IS NULL THEN
    RAISE EXCEPTION 'MISSING: storage.objects does not exist although storage.buckets does; the message-photos fence cannot be proven.';
  END IF;

  SELECT c.relrowsecurity, c.relowner INTO v_rls, v_owner FROM pg_catalog.pg_class c WHERE c.oid = v_objects;
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'EXPOSURE: row level security is disabled on storage.objects, so table grants alone decide who reads message-photos objects. Fix: ask Supabase support to re-enable RLS on storage.objects (it is on by default), then re-run this verifier.';
  END IF;

  SELECT count(*) INTO v_fence_count
    FROM pg_catalog.pg_policy p
   WHERE p.polrelid = v_objects AND p.polname = 'message_photos_api_roles_fence';
  IF v_fence_count <> 1 THEN
    RAISE EXCEPTION 'EXPOSURE: the restrictive fence message_photos_api_roles_fence on storage.objects is missing. Fix: re-apply the idempotent migration file with npx prisma db execute --url "$DIRECT_URL" --file prisma/migrations/20270306000000_message_photos/migration.sql, then re-run this verifier.';
  END IF;
  SELECT p.polpermissive AS permissive,
         p.polcmd AS cmd,
         p.polroles AS roles,
         pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS qual,
         pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
    INTO v_fence
    FROM pg_catalog.pg_policy p
   WHERE p.polrelid = v_objects AND p.polname = 'message_photos_api_roles_fence';
  IF v_fence.permissive IS DISTINCT FROM false
     OR v_fence.cmd IS DISTINCT FROM '*'
     OR v_fence.roles IS DISTINCT FROM ARRAY[0::oid]
     OR v_fence.qual IS DISTINCT FROM v_expected
     OR v_fence.with_check IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'EXPOSURE: the restrictive fence message_photos_api_roles_fence on storage.objects was altered (permissive %, cmd %, roles %, qual %, with_check %). Fix: re-apply the idempotent migration file with npx prisma db execute --url "$DIRECT_URL" --file prisma/migrations/20270306000000_message_photos/migration.sql, then re-run this verifier.',
      v_fence.permissive, v_fence.cmd, v_fence.roles, v_fence.qual, v_fence.with_check;
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_role) THEN
      RAISE EXCEPTION 'MISSING: API role % does not exist on this Supabase database; the message-photos fence cannot be proven for it.', v_role;
    END IF;
    IF EXISTS (
      SELECT 1
        FROM pg_catalog.pg_roles r
       WHERE (r.rolsuper OR r.rolbypassrls OR r.oid = v_owner)
         AND pg_catalog.pg_has_role(v_role, r.oid, 'MEMBER')
    ) THEN
      RAISE EXCEPTION 'EXPOSURE: API role % is, or is a member of, a role that bypasses row level security on storage.objects (superuser, BYPASSRLS or the table owner). Fix: revoke that membership or attribute, then re-run this verifier.', v_role;
    END IF;
  END LOOP;

  SELECT format('%I.%I', n.nspname, v.relname) INTO v_view
    FROM pg_catalog.pg_rewrite rw
    JOIN pg_catalog.pg_depend d
      ON d.classid = 'pg_catalog.pg_rewrite'::regclass AND d.objid = rw.oid
    JOIN pg_catalog.pg_class v ON v.oid = rw.ev_class
    JOIN pg_catalog.pg_namespace n ON n.oid = v.relnamespace
    JOIN pg_catalog.pg_roles o ON o.oid = v.relowner
   WHERE d.refclassid = 'pg_catalog.pg_class'::regclass
     AND d.refobjid = v_objects
     AND v.oid <> v_objects
     AND v.relkind IN ('v', 'm')
     AND (o.rolsuper OR o.rolbypassrls OR pg_catalog.pg_has_role(o.oid, v_owner, 'USAGE'))
     AND NOT (
       v.relkind = 'v'
       AND coalesce(v.reloptions, ARRAY[]::text[]) && ARRAY['security_invoker=true', 'security_invoker=on', 'security_invoker=1', 'security_invoker=yes']
     )
     AND (
       pg_catalog.has_table_privilege('anon', v.oid, 'SELECT')
       OR pg_catalog.has_table_privilege('authenticated', v.oid, 'SELECT')
     )
   ORDER BY 1
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'EXPOSURE: view % reads storage.objects as an owner that bypasses row level security and anon/authenticated may select it, so the message-photos fence does not apply to them. Fix: drop it, set security_invoker = true, or revoke SELECT from anon and authenticated, then re-run this verifier.', v_view;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role' AND (rolbypassrls OR rolsuper)
  ) THEN
    RAISE EXCEPTION 'SERVICE: service_role is missing or does not bypass row level security, so the message-photos fence would block the backend. Fix: restore the Supabase default (service_role BYPASSRLS), then re-run this verifier.';
  END IF;

  RAISE NOTICE 'message-photos verifier: bucket private, RLS on, restrictive fence intact, API roles bound by RLS, no RLS-escaping view, service_role bypasses RLS.';
END
$verify_message_photos_bucket$;
