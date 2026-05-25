# Supabase Project Configuration — Dashboard Settings

**Project:** `rpyfdsgxxltzutgqeouk` (FITNESS TGP primary)
**Owner of record:** Dynasia G (`dynasia@trygrowthproject.com`)
**Last updated:** 2026-05-25

This file records dashboard-only Supabase configuration that cannot be expressed in a Prisma migration. Each entry lists the setting, the desired state, the verification step, and the operator + date confirmation log.

The canonical operator copy lives in `agent-context/SUPABASE_CONFIG.md`; this in-repo copy ships with each PR that adds or changes a dashboard requirement so the PR is self-describing during review.

---

## Authentication — Leaked Password Protection (HaveIBeenPwned)

| Field | Value |
|---|---|
| Path | Supabase Dashboard → Authentication → Settings → Auth providers |
| Setting | "Leaked password protection" / HaveIBeenPwned password check |
| Desired state | **ON** |
| Linked PR | PR-RLS-01 |
| Spec reference | `docs/SPEC_pr_rls_01_helper_searchpath_hibp.md` section 3.2 |

### Why

Without this toggle, Supabase Auth accepts any password, including ones already present in public breach corpora. Credential stuffing accounts for the majority of consumer-SaaS account-takeover incidents; the HIBP k-anonymity check is free per request and blocks trivial password reuse pivots. The Supabase advisor flags this state with the `auth_leaked_password_protection` lint (WARN).

### Operator steps

1. Sign in to the Supabase Dashboard with an account that is a member of the project organisation.
2. Open project `rpyfdsgxxltzutgqeouk`.
3. Navigate Authentication → Settings → "Auth providers" / "Password" section.
4. Toggle **Leaked password protection** → ON.
5. Save.

### Verification

After saving, re-pull the advisor:

```
mcp:supabase:get_advisors project_id=rpyfdsgxxltzutgqeouk type=security
```

The `auth_leaked_password_protection` entry should be absent from the returned lints.

Manual smoke test: from a clean browser, attempt to register `test+hibp@trygrowthproject.com` with password `Password123!`. Supabase Auth should reject the request with an error referencing leaked or pwned passwords.

### Confirmation log

| Date | Operator | Action | Advisor verified |
|---|---|---|---|
| _pending_ | Dynasia G | Toggle ON | _fill after operator flip_ |

---

## Helper function search_path lockdown

The five flagged helpers (`app.current_user_id`, `app.current_user_role`, `app.is_owner`, `app.is_current_coach_of`, `public.enforce_subcoach_head_cap`) are addressed by SQL migration `prisma/migrations/20260525000000_rls01_helper_searchpath_hibp`. No dashboard action required.

Post-deploy verification:

```
mcp:supabase:get_advisors project_id=rpyfdsgxxltzutgqeouk type=security
```

The five `function_search_path_mutable` lints should drop to zero. The full SQL used to verify on the live DB:

```sql
SELECT n.nspname AS schema,
       p.proname AS name,
       p.proconfig AS config,
       p.prosecdef AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE (n.nspname = 'app' AND p.proname IN ('current_user_id', 'current_user_role', 'is_owner', 'is_current_coach_of'))
   OR (n.nspname = 'public' AND p.proname = 'enforce_subcoach_head_cap')
ORDER BY n.nspname, p.proname;
```

Expected result after deploy: every row shows `security_definer = true` and `config` contains `search_path=pg_catalog, public, app`.
