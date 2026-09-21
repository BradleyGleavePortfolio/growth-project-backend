# S1-R3-A-01 (S1 R4) — effective-TRUNCATE regression controls for verify.sql.
# Sourced by test/db/s1-rls-close-public-exposure.sh (full proof harness, DB1 after
# the candidate is applied) AND by test/db/s1-r4-truncate-discriminator.sh (narrow
# standalone run on an already protected synthetic database). ONE implementation of
# the assertions so both entry points prove exactly the same thing.
#
# Why: PostgreSQL row security governs SELECT/INSERT/UPDATE/DELETE only. TRUNCATE is
# a separate table privilege that RLS (even FORCE + RESTRICTIVE deny-all) never
# consults, so an API role holding only TRUNCATE on a server-only table can empty it
# while the CRUD-only predecessor verifier (frozen head b7d7fe59) reports protected.
# The R4 verifier adds TRUNCATE to the has_table_privilege loop (effective semantics:
# direct grants, PUBLIC grants and inherited memberships).
#
# Controls (all on the seeded standalone public."MuxProcessedEvent" — nothing
# references it by FK — restored after every step; the seeded row is never lost):
#   C0  positive: current verifier passes on the protected state (both routes)
#   C1  direct `GRANT TRUNCATE ... TO anon`  -> effective CRUD f,f,f,f TRUNCATE t;
#       PREDECESSOR verifier exits 0 (the false green); CURRENT verifier exits
#       non-zero, class "1 exposure problem(s); 0 allowed-path problem(s)", message
#       names "MuxProcessedEvent: anon still holds TRUNCATE"; Prisma route non-zero;
#       behavioural corroboration in a ROLLBACK-ONLY transaction: SET ROLE anon can
#       TRUNCATE the FORCE-RLS deny-all table (00000), in-transaction count 0, after
#       ROLLBACK the owner still sees the seeded row. Restore -> positive again.
#   C2  direct `GRANT TRUNCATE ... TO authenticated` -> current fails naming
#       authenticated; restore -> positive.
#   C3  PUBLIC-only `GRANT TRUNCATE ... TO PUBLIC` (no direct anon/authenticated ACL
#       entry) -> effective TRUNCATE t for both API roles; predecessor exits 0;
#       current exits non-zero with 2 exposure problems naming both roles; Prisma
#       route non-zero; restore -> positive (both routes).
#   C4  baseline: without the grant, SET ROLE anon TRUNCATE is refused 42501 (the
#       privilege, not RLS, is what gates the operation).
#
# Contract for the caller (all must already be defined; the harness defines them):
#   check <desc> <expected> <actual> ; ok <desc> ; bad <desc>
#   q <url> <sql>                      -> psql -qAt, errors appended to $LOG
#   verify_rc <url>                    -> 0/1 for the CURRENT verify.sql via psql ON_ERROR_STOP
#   verify_msg <url>                   -> the single "S1-DB-01 VERIFY ..." line, current verifier
#   prisma_verify_rc <url>             -> 0/1 for the CURRENT verify.sql via `prisma db execute`
#   rc0 <exitcode>                     -> 0 if 0 else 1
#   $LOG $MIG_DIR                      -> detail log path; migration directory (relative to repo root)
#
# s1_truncate_controls <owner_url> <authenticator_url> <predecessor_verify_sql_path>
#   owner_url:          the table-owning fixture role (postgres, BYPASSRLS) — issues GRANT/REVOKE
#   authenticator_url:  LOGIN NOINHERIT role that can SET ROLE anon/authenticated/service_role
#   predecessor path:   the frozen b7d7fe59 verify.sql, already extracted and sha256-pinned by the caller

S1_TRUNC_TABLE='"MuxProcessedEvent"'

# effective privileges of <role> on the control table: "S,I,U,D,T" as t/f letters
s1_trunc_eff() { # <url> <role>
  q "$1" "select concat_ws(',', has_table_privilege('$2','$S1_TRUNC_TABLE','SELECT'), has_table_privilege('$2','$S1_TRUNC_TABLE','INSERT'), has_table_privilege('$2','$S1_TRUNC_TABLE','UPDATE'), has_table_privilege('$2','$S1_TRUNC_TABLE','DELETE'), has_table_privilege('$2','$S1_TRUNC_TABLE','TRUNCATE'))"
}
# number of DIRECT ACL entries for anon/authenticated on the control table (0 = PUBLIC-only or none)
s1_trunc_direct_acl() { # <url>
  q "$1" "select count(*) from aclexplode((select relacl from pg_class where oid='$S1_TRUNC_TABLE'::regclass)) a where a.grantee in (select oid from pg_roles where rolname in ('anon','authenticated'))"
}
# predecessor verifier exit (0/1) via psql ON_ERROR_STOP, same route as verify_rc
s1_trunc_pred_rc() { # <url> <file>
  psql "$1" -X -q -v ON_ERROR_STOP=1 -f "$2" >>"$LOG" 2>&1; rc0 $?
}
# ROLLBACK-ONLY behavioural probe: one authenticator connection; BEGIN; SET LOCAL ROLE anon;
# TRUNCATE; then count as service_role inside the same transaction; ROLLBACK. Prints
# "SQLSTATE=<state of the truncate>|IN_TXN_COUNT=<n or 'n/a'>". Never commits.
s1_trunc_probe_rollback_only() { # <authenticator_url>
  local out st cnt
  out=$(psql "$1" -X -qAt -v ON_ERROR_STOP=0 -v VERBOSITY=verbose 2>&1 <<EOSQL
begin;
set local role anon;
truncate table $S1_TRUNC_TABLE;
set local role service_role;
select 'IN_TXN_COUNT='||count(*) from $S1_TRUNC_TABLE;
rollback;
EOSQL
)
  printf '%s\n' "$out" >>"$LOG"
  st=$(printf '%s\n' "$out" | sed -n 's/^.*ERROR:  \([0-9A-Z]\{5\}\):.*/\1/p' | head -1)
  cnt=$(printf '%s\n' "$out" | sed -n 's/^IN_TXN_COUNT=//p' | head -1)
  echo "SQLSTATE=${st:-00000}|IN_TXN_COUNT=${cnt:-n/a}"
}

s1_truncate_controls() {
  local OWNER=$1 AUTHN=$2 PRED=$3
  local seed vm
  [ -s "$PRED" ] || { bad "R4 TRUNCATE controls: predecessor verifier file missing/empty ($PRED); controls NOT run"; return 1; }
  seed=$(q "$OWNER" "select count(*) from $S1_TRUNC_TABLE")
  check "R4 TRUNCATE C0: control table $S1_TRUNC_TABLE is seeded (>=1 row) so a destructive probe is observable" 1 "$([ "${seed:-0}" -ge 1 ] 2>/dev/null && echo 1 || echo 0)"
  check "R4 TRUNCATE C0: no foreign key references the control table (TRUNCATE would otherwise need CASCADE)" 0 "$(q "$OWNER" "select count(*) from pg_constraint where contype='f' and confrelid='$S1_TRUNC_TABLE'::regclass")"
  check "R4 TRUNCATE C0: protected state — anon effective S,I,U,D,T all false" "f,f,f,f,f" "$(s1_trunc_eff "$OWNER" anon)"
  check "R4 TRUNCATE C0: protected state — authenticated effective S,I,U,D,T all false" "f,f,f,f,f" "$(s1_trunc_eff "$OWNER" authenticated)"
  check "R4 TRUNCATE C0: CURRENT verify.sql passes on the protected state (psql route)" 0 "$(verify_rc "$OWNER")"
  check "R4 TRUNCATE C0: PREDECESSOR (b7d7fe59) verify.sql also passes on the protected state (both agree on the positive)" 0 "$(s1_trunc_pred_rc "$OWNER" "$PRED")"
  check "R4 TRUNCATE C4: baseline — SET ROLE anon TRUNCATE is refused 42501 without the privilege (rollback-only txn)" "SQLSTATE=42501|IN_TXN_COUNT=n/a" "$(s1_trunc_probe_rollback_only "$AUTHN")"
  check "R4 TRUNCATE C4: seeded rows intact after the refused probe" "$seed" "$(q "$OWNER" "select count(*) from $S1_TRUNC_TABLE")"

  # ---- C1: direct grant to anon --------------------------------------------------------------
  q "$OWNER" "grant truncate on table $S1_TRUNC_TABLE to anon" >/dev/null
  check "R4 TRUNCATE C1: after direct grant, anon effective privileges are S,I,U,D=f and TRUNCATE=t" "f,f,f,f,t" "$(s1_trunc_eff "$OWNER" anon)"
  check "R4 TRUNCATE C1: authenticated unaffected by the anon grant" "f,f,f,f,f" "$(s1_trunc_eff "$OWNER" authenticated)"
  check "R4 TRUNCATE C1: RLS invariants unchanged (enabled+forced, 3 policies) — only the privilege drifted" "t,t,3" \
    "$(q "$OWNER" "select concat_ws(',', c.relrowsecurity, c.relforcerowsecurity, (select count(*) from pg_policy where polrelid=c.oid)) from pg_class c where c.oid='$S1_TRUNC_TABLE'::regclass")"
  check "R4 TRUNCATE C1 DISCRIMINATOR: PREDECESSOR (b7d7fe59) verify.sql exits ZERO with anon holding TRUNCATE (the S1-R3-A-01 false green)" 0 "$(s1_trunc_pred_rc "$OWNER" "$PRED")"
  check "R4 TRUNCATE C1 DISCRIMINATOR: CURRENT verify.sql exits NON-ZERO (psql route)" 1 "$(verify_rc "$OWNER")"
  vm=$(verify_msg "$OWNER")
  check "R4 TRUNCATE C1: classified EXPOSURE — '1 exposure problem(s); 0 allowed-path problem(s)'" 1 "$(printf '%s\n' "$vm" | grep -c '1 exposure problem(s); 0 allowed-path problem(s)')"
  check "R4 TRUNCATE C1: message names the relation, role and privilege" 1 "$(printf '%s\n' "$vm" | grep -c 'EXPOSURE: MuxProcessedEvent: anon still holds TRUNCATE')"
  check "R4 TRUNCATE C1 (S2 gate route): prisma db execute --file verify.sql exits NON-ZERO with anon holding TRUNCATE" 1 "$(prisma_verify_rc "$OWNER")"
  check "R4 TRUNCATE C1 behaviour (rollback-only): SET ROLE anon CAN TRUNCATE the FORCE-RLS deny-all table (00000) and the table is empty inside the txn" "SQLSTATE=00000|IN_TXN_COUNT=0" "$(s1_trunc_probe_rollback_only "$AUTHN")"
  check "R4 TRUNCATE C1 behaviour: after ROLLBACK the owner still sees every seeded row (no destruction committed)" "$seed" "$(q "$OWNER" "select count(*) from $S1_TRUNC_TABLE")"
  q "$OWNER" "revoke truncate on table $S1_TRUNC_TABLE from anon" >/dev/null
  check "R4 TRUNCATE C1 restore: anon effective privileges back to all false" "f,f,f,f,f" "$(s1_trunc_eff "$OWNER" anon)"
  check "R4 TRUNCATE C1 restore: CURRENT verify.sql passes again (psql route)" 0 "$(verify_rc "$OWNER")"

  # ---- C2: direct grant to authenticated -----------------------------------------------------
  q "$OWNER" "grant truncate on table $S1_TRUNC_TABLE to authenticated" >/dev/null
  check "R4 TRUNCATE C2: after direct grant, authenticated effective TRUNCATE=t" "f,f,f,f,t" "$(s1_trunc_eff "$OWNER" authenticated)"
  check "R4 TRUNCATE C2: CURRENT verify.sql exits NON-ZERO" 1 "$(verify_rc "$OWNER")"
  vm=$(verify_msg "$OWNER")
  check "R4 TRUNCATE C2: message names authenticated" 1 "$(printf '%s\n' "$vm" | grep -c 'EXPOSURE: MuxProcessedEvent: authenticated still holds TRUNCATE')"
  q "$OWNER" "revoke truncate on table $S1_TRUNC_TABLE from authenticated" >/dev/null
  check "R4 TRUNCATE C2 restore: CURRENT verify.sql passes again" 0 "$(verify_rc "$OWNER")"

  # ---- C3: PUBLIC-only grant (effective, no direct API-role ACL entry) -----------------------
  q "$OWNER" "grant truncate on table $S1_TRUNC_TABLE to public" >/dev/null
  check "R4 TRUNCATE C3: PUBLIC grant leaves NO direct anon/authenticated ACL entry (effective-only case)" 0 "$(s1_trunc_direct_acl "$OWNER")"
  check "R4 TRUNCATE C3: anon effective TRUNCATE=t via PUBLIC" "f,f,f,f,t" "$(s1_trunc_eff "$OWNER" anon)"
  check "R4 TRUNCATE C3: authenticated effective TRUNCATE=t via PUBLIC" "f,f,f,f,t" "$(s1_trunc_eff "$OWNER" authenticated)"
  check "R4 TRUNCATE C3 DISCRIMINATOR: PREDECESSOR (b7d7fe59) verify.sql exits ZERO with PUBLIC holding TRUNCATE" 0 "$(s1_trunc_pred_rc "$OWNER" "$PRED")"
  check "R4 TRUNCATE C3 DISCRIMINATOR: CURRENT verify.sql exits NON-ZERO (psql route)" 1 "$(verify_rc "$OWNER")"
  vm=$(verify_msg "$OWNER")
  check "R4 TRUNCATE C3: classified EXPOSURE with one line per API role — '2 exposure problem(s); 0 allowed-path problem(s)'" 1 "$(printf '%s\n' "$vm" | grep -c '2 exposure problem(s); 0 allowed-path problem(s)')"
  check "R4 TRUNCATE C3: message names both anon and authenticated" "1|1" "$(printf '%s\n' "$vm" | grep -c 'MuxProcessedEvent: anon still holds TRUNCATE')|$(printf '%s\n' "$vm" | grep -c 'MuxProcessedEvent: authenticated still holds TRUNCATE')"
  check "R4 TRUNCATE C3 (S2 gate route): prisma db execute --file verify.sql exits NON-ZERO on the PUBLIC-only grant" 1 "$(prisma_verify_rc "$OWNER")"
  q "$OWNER" "revoke truncate on table $S1_TRUNC_TABLE from public" >/dev/null
  check "R4 TRUNCATE C3 restore: anon and authenticated effective privileges back to all false" "f,f,f,f,f|f,f,f,f,f" "$(s1_trunc_eff "$OWNER" anon)|$(s1_trunc_eff "$OWNER" authenticated)"
  check "R4 TRUNCATE C3 restore: CURRENT verify.sql passes again (psql route)" 0 "$(verify_rc "$OWNER")"
  check "R4 TRUNCATE C3 restore (S2 gate route): prisma db execute --file verify.sql exits ZERO again" 0 "$(prisma_verify_rc "$OWNER")"
  check "R4 TRUNCATE restore: seeded rows intact at the end of the controls" "$seed" "$(q "$OWNER" "select count(*) from $S1_TRUNC_TABLE")"
  return 0
}
