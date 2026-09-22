#!/usr/bin/env bash
# Offline exact-string spec for the S1 R4 TRUNCATE message predicates (S1-R4-A-01).
#
# No database, no network, no install; bash + grep only, well under a second. Proves that
# the fixed-string predicates in test/db/_support/s1-truncate-controls.sh (S1_TRUNC_MSG_*
# + s1_trunc_msg_count) ACCEPT the verifier's real diagnostic shape - relation names are
# emitted by format('%I') and are therefore double-quoted for the mixed-case
# "MuxProcessedEvent" - and REJECT wrong role, wrong privilege, wrong class
# (ALLOWED-PATH), the OK notice, and the unquoted spelling the R4 first draft expected.
#
# Fixture strings: two fragments are VERBATIM from the real B1 composed verifier output
# (execution/s2-composition/composition/20260922T000811Z/harness/C3.release.log,
# sha256 948249c7b4f3597ac3c225e45a7f9d6aa51b07f63f4ca4fb1bded933a10f8ca7); the single-
# and two-problem lines are composed from the verifier's RAISE EXCEPTION format string
# and the same %I-quoted problem text. This spec does NOT claim any database result; it
# only pins the predicates to the diagnostic grammar the real verifier produced.
set -u
cd "$(dirname "$0")/../.."
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL  $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$2] got [$3])"; fi; }
VERIFY=prisma/migrations/20261224000000_rls_close_public_exposure/verify.sql
. test/db/_support/s1-truncate-controls.sh   # definitions only; no connection is made

echo "== S1 R4 TRUNCATE message spec (offline) head=$(git rev-parse --short HEAD 2>/dev/null || echo n/a)"
echo "controls_sha256=$(sha256sum test/db/_support/s1-truncate-controls.sh | cut -c1-64)"
echo "verify_sql_sha256=$(sha256sum $VERIFY | cut -c1-64)"

# ---- 1. source coupling: the predicates must match the verifier's actual format strings
check "verify.sql emits API-role privilege problems as format('%I: %s still holds %s') (quoted relation)" 1 \
  "$(grep -cF "format('%I: %s still holds %s', t, api_role, priv)" $VERIFY)"
check "verify.sql RAISE line is 'S1-DB-01 VERIFY FAILED (% exposure problem(s); % allowed-path problem(s)): %'" 1 \
  "$(grep -cF "RAISE EXCEPTION 'S1-DB-01 VERIFY FAILED (% exposure problem(s); % allowed-path problem(s)): %'" $VERIFY)"
check "verify.sql prefixes the exposure list with 'EXPOSURE: ' and joins problems with '; '" 1 \
  "$(grep -cF "THEN 'EXPOSURE: ' || array_to_string(exposure, '; ')" $VERIFY)"
check "verify.sql privilege array is SELECT,INSERT,UPDATE,DELETE,TRUNCATE" 1 \
  "$(grep -cF "ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']" $VERIFY)"

# ---- 2. fixtures
B1_FRAG_ANON='"MuxProcessedEvent": anon still holds DELETE; "MuxProcessedEvent": anon still holds TRUNCATE; "MuxProcessedEvent": restrictive deny-all policy for authenticated missing; "MuxProcessedEvent": authenticated still holds SELECT'
B1_FRAG_AUTHN='s INSERT; "MuxProcessedEvent": authenticated still holds UPDATE; "MuxProcessedEvent": authenticated still holds DELETE; "MuxProcessedEvent": authenticated still holds TRUNCATE; "NudgeLog": RLS not enabled; "NudgeLog": RLS not forced; "'
PFX='S1-DB-01 VERIFY FAILED'
M_C1="$PFX (1 exposure problem(s); 0 allowed-path problem(s)): EXPOSURE: \"MuxProcessedEvent\": anon still holds TRUNCATE"
M_C2="$PFX (1 exposure problem(s); 0 allowed-path problem(s)): EXPOSURE: \"MuxProcessedEvent\": authenticated still holds TRUNCATE"
M_C3="$PFX (2 exposure problem(s); 0 allowed-path problem(s)): EXPOSURE: \"MuxProcessedEvent\": anon still holds TRUNCATE; \"MuxProcessedEvent\": authenticated still holds TRUNCATE"
M_ALLOWED="$PFX (0 exposure problem(s); 1 allowed-path problem(s)): ALLOWED-PATH: DunningAttempt: service_role lost SELECT"
M_RLSOFF="$PFX (2 exposure problem(s); 0 allowed-path problem(s)): EXPOSURE: \"DunningAttempt\": RLS not enabled; \"DunningAttempt\": RLS not forced"
M_DELETE="$PFX (1 exposure problem(s); 0 allowed-path problem(s)): EXPOSURE: \"MuxProcessedEvent\": anon still holds DELETE"
M_OK='S1-DB-01 VERIFY OK: 18 relations protected (4 community_messages partitions), 5 functions pinned, service_role path intact'
M_UNQUOTED_DRAFT="$PFX (1 exposure problem(s); 0 allowed-path problem(s)): EXPOSURE: MuxProcessedEvent: anon still holds TRUNCATE"
OLD_NEEDLE_ANON='EXPOSURE: MuxProcessedEvent: anon still holds TRUNCATE'   # the R4 first-draft expectation

# ---- 3. accept: real B1 fragments and the composed single/two-problem lines
check "real B1 fragment contains the quoted anon TRUNCATE problem" 1 "$(s1_trunc_msg_count "$B1_FRAG_ANON" "$S1_TRUNC_MSG_ANON")"
check "real B1 fragment contains the quoted authenticated TRUNCATE problem" 1 "$(s1_trunc_msg_count "$B1_FRAG_AUTHN" "$S1_TRUNC_MSG_AUTHN")"
check "real B1 fragment does NOT match the first-draft unquoted needle (the S1-R4-A-01 defect, reproduced)" 0 "$(s1_trunc_msg_count "$B1_FRAG_ANON" "$OLD_NEEDLE_ANON")"
check "C1 line: class 1/0 accepted" 1 "$(s1_trunc_msg_count "$M_C1" "$S1_TRUNC_MSG_CLASS1")"
check "C1 line: sole-problem anon needle accepted" 1 "$(s1_trunc_msg_count "$M_C1" "$S1_TRUNC_MSG_ONLY_ANON")"
check "C1 line: authenticated needle rejected (wrong role)" 0 "$(s1_trunc_msg_count "$M_C1" "$S1_TRUNC_MSG_AUTHN")"
check "C2 line: sole-problem authenticated needle accepted" 1 "$(s1_trunc_msg_count "$M_C2" "$S1_TRUNC_MSG_ONLY_AUTHN")"
check "C2 line: anon needle rejected (wrong role)" 0 "$(s1_trunc_msg_count "$M_C2" "$S1_TRUNC_MSG_ANON")"
check "C3 line: class 2/0 accepted" 1 "$(s1_trunc_msg_count "$M_C3" "$S1_TRUNC_MSG_CLASS2")"
check "C3 line: both role needles accepted" "1|1" "$(s1_trunc_msg_count "$M_C3" "$S1_TRUNC_MSG_ANON")|$(s1_trunc_msg_count "$M_C3" "$S1_TRUNC_MSG_AUTHN")"
check "C3 line: class 1/0 rejected (wrong class count)" 0 "$(s1_trunc_msg_count "$M_C3" "$S1_TRUNC_MSG_CLASS1")"
check "C3 line would FAIL C1's 'does NOT name authenticated' assertion (C1 and C3 are distinguishable)" 1 "$(s1_trunc_msg_count "$M_C3" "$S1_TRUNC_MSG_AUTHN")"

# ---- 4. reject: wrong class, wrong privilege, OK notice, unquoted spelling
check "ALLOWED-PATH line: class 1/0 rejected" 0 "$(s1_trunc_msg_count "$M_ALLOWED" "$S1_TRUNC_MSG_CLASS1")"
check "ALLOWED-PATH line: anon/authenticated needles rejected" "0|0" "$(s1_trunc_msg_count "$M_ALLOWED" "$S1_TRUNC_MSG_ANON")|$(s1_trunc_msg_count "$M_ALLOWED" "$S1_TRUNC_MSG_AUTHN")"
check "RLS-disabled EXPOSURE line (other relation): anon/authenticated TRUNCATE needles rejected" "0|0" "$(s1_trunc_msg_count "$M_RLSOFF" "$S1_TRUNC_MSG_ANON")|$(s1_trunc_msg_count "$M_RLSOFF" "$S1_TRUNC_MSG_AUTHN")"
check "DELETE-only exposure: TRUNCATE needle rejected (wrong privilege)" 0 "$(s1_trunc_msg_count "$M_DELETE" "$S1_TRUNC_MSG_ANON")"
check "OK notice: every needle rejected" "0|0|0|0" "$(s1_trunc_msg_count "$M_OK" "$S1_TRUNC_MSG_CLASS1")|$(s1_trunc_msg_count "$M_OK" "$S1_TRUNC_MSG_CLASS2")|$(s1_trunc_msg_count "$M_OK" "$S1_TRUNC_MSG_ANON")|$(s1_trunc_msg_count "$M_OK" "$S1_TRUNC_MSG_AUTHN")"
check "empty message (verifier produced nothing): every needle rejected" "0|0" "$(s1_trunc_msg_count "" "$S1_TRUNC_MSG_CLASS1")|$(s1_trunc_msg_count "" "$S1_TRUNC_MSG_ANON")"
check "unquoted spelling (which the real verifier never emits for this relation) is NOT accepted by the corrected needle" 0 "$(s1_trunc_msg_count "$M_UNQUOTED_DRAFT" "$S1_TRUNC_MSG_ANON")"
check "controls no longer contain the unquoted first-draft needle" 0 "$(grep -cF 'EXPOSURE: MuxProcessedEvent:' test/db/_support/s1-truncate-controls.sh)"

echo "== $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
