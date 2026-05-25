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

The log is intentionally left `_pending_` in the PR; the operator updates it in the same commit as the dashboard flip so reviewers can correlate the toggle event to a real datetime + advisor pull. This row is the only piece of PR-RLS-01 that lands in main with placeholder text.

### Incident / detection runbook (audit P2-004)

Leaked-password protection is a dashboard-only control. It can be re-disabled silently (intentionally or accidentally) without any code change, so the operator runbook below treats it as a recurring detection problem, not a one-shot setting.

**Owner of record:** Dynasia G (founder).
**Backup owner:** none until first engineering hire; until then a weekly calendar reminder substitutes for an on-call rotation.

**Detection cadence:**

1. **Weekly through launch + 90 days.** Founder runs `mcp:supabase:get_advisors project_id=rpyfdsgxxltzutgqeouk type=security` every Monday and confirms `auth_leaked_password_protection` is absent from the returned lints. Reminder lives in the founder's recurring calendar block titled "Supabase advisor check".
2. **Every PR that touches `docs/SUPABASE_CONFIG.md` or `supabase/`.** CI does not currently re-pull the advisor (no service-role secret in PR runners), so reviewers manually re-pull during review of any auth-adjacent PR.
3. **Release-blocking smoke test.** Each release of the iOS/web app, the founder attempts to register `test+hibp@trygrowthproject.com` with a known-leaked password from the HIBP corpus (e.g. `Password123!`). A successful registration is a P0 incident: HIBP toggled OFF.

**Alert path:**

- The advisor and smoke test are manual. There is no automated alert until a Supabase-advisor-to-Slack/email integration ships in a later cycle.
- If the founder is unavailable for >7 days, the Monday check is the founder's responsibility on return and the missed slot is logged in the launch ops journal.

**Incident response — leaked-password protection is OFF after the toggle was ON:**

1. Immediately re-toggle ON via the dashboard. No SQL change required.
2. Within 1 hour, scan `auth.users.created_at` for the gap between toggle-off detection and re-enable; capture the count. These accounts may have been created with leaked passwords.
3. Within 24 hours, send a forced-password-reset email to the at-risk cohort (template lives in the auth runbook outside this repo). Communicate the reason in plain language.
4. Within 7 days, document the timeline, root cause, and corrective action in the Cycle B retrospective and link it from this file.
5. If the toggle was flipped maliciously (audit log shows a non-founder operator), follow the standard SaaS account-compromise drill: rotate all Supabase service-role keys, invalidate the offending Supabase dashboard session, and notify the Supabase support channel.

**Rollback:**

Intentional rollback (e.g. a third-party password manager fails under HIBP and we need to investigate) is performed by toggling OFF in the dashboard, updating the confirmation log row above with action "Toggle OFF", and opening a tracking issue with a deadline to re-enable.

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
