# Incident Runbook: Secret Exposed

**Who this is for:** Bradley (and any operator managing The Growth Project backend).

**Plain-English summary:** This document tells you exactly what to do in the first 60 minutes after you suspect a secret has been exposed — meaning an API key, password, or signing key has potentially been seen by someone who should not have it. Move fast. The slower you act, the more damage can happen.

---

## First: stay calm, move quickly

A secret exposure is a serious incident but it is survivable. The most important thing is to revoke the secret immediately — before worrying about how it happened or who saw it.

**Do not:**
- Spend time investigating the root cause before revoking
- Post the secret value in Slack, email, or GitHub issues (even to describe it)
- Commit the secret to git to "preserve evidence"
- Wait to see if anyone misuses it

---

## Step 1: Identify what was exposed (1 minute)

Figure out which secret was exposed. Common scenarios:

| What happened | Which secret to revoke |
|---|---|
| Secret committed to a git repo | Whatever was in the commit — check `git log --all -p` |
| Accidentally pasted in Slack/email | That specific key |
| Error message shows a connection string | `DATABASE_URL` or `REDIS_URL` |
| Log line shows a JWT or bearer token | `JWT_SIGNING_KEY` or `SUPABASE_SERVICE_ROLE_KEY` |
| Old `.env` file found on a dev machine | All secrets — assume all were exposed |
| Fly.io account compromised | All secrets |

---

## Step 2: Revoke immediately (minutes 2–10)

Do NOT wait for confirmation. Revoke now, investigate later. Use the `docs/runbooks/secrets-rotation.md` playbook for each secret, following the "rotate immediately" path.

### Fast revocation commands (copy-paste ready)

**JWT signing key compromised:**

```sh
# Generate new key
NEW_KEY=$(openssl rand -hex 32)

# Set immediately — do NOT set a "previous" key during an incident
# (you want the old key to stop working right now)
flyctl secrets set JWT_SIGNING_KEY="$NEW_KEY" -a backend-spring-lake-3890
flyctl secrets unset JWT_SIGNING_KEY_PREVIOUS -a backend-spring-lake-3890
```

Note: This will log out all users immediately. That is the correct behavior during an incident — better than an attacker using the compromised key.

**Database password compromised:**

1. Go to Supabase → Settings → Database → Reset database password (this invalidates all existing connections immediately)
2. Copy the new connection string
3. `flyctl secrets set DATABASE_URL="postgresql://new-url" -a backend-spring-lake-3890`

**Supabase service-role key compromised:**

1. Go to Supabase → Settings → API → Roll the service_role key
2. `flyctl secrets set SUPABASE_SERVICE_ROLE_KEY="new-key" -a backend-spring-lake-3890`

**Stripe key compromised:**

1. Go to Stripe → Developers → API keys → Roll key (set transition period to 0 hours for immediate revocation)
2. `flyctl secrets set STRIPE_SECRET_KEY="sk_live_new..." -a backend-spring-lake-3890`

**Finance service token compromised:**

```sh
NEW_TOKEN=$(openssl rand -hex 32)
flyctl secrets set FINANCE_SERVICE_TOKEN="$NEW_TOKEN" -a backend-spring-lake-3890
# IMPORTANT: Also set this on the finance backend immediately
```

**All secrets compromised (worst case — assume full breach):**

```sh
# Do this in order (hardest/most critical first)
# 1. Database — first because data is most valuable
#    Go to Supabase and reset the database password, then:
flyctl secrets set DATABASE_URL="new-url" -a backend-spring-lake-3890

# 2. Supabase service role key
#    Go to Supabase and roll the key, then:
flyctl secrets set SUPABASE_SERVICE_ROLE_KEY="new-key" -a backend-spring-lake-3890

# 3. JWT signing key (logs out all users)
flyctl secrets set JWT_SIGNING_KEY="$(openssl rand -hex 32)" -a backend-spring-lake-3890
flyctl secrets unset JWT_SIGNING_KEY_PREVIOUS -a backend-spring-lake-3890

# 4. Stripe (from Stripe dashboard)
flyctl secrets set STRIPE_SECRET_KEY="sk_live_new..." -a backend-spring-lake-3890
flyctl secrets set STRIPE_WEBHOOK_SECRET="whsec_new..." -a backend-spring-lake-3890

# 5. Other secrets
flyctl secrets set PERPLEXITY_API_KEY="new..." -a backend-spring-lake-3890
flyctl secrets set FINANCE_SERVICE_TOKEN="$(openssl rand -hex 32)" -a backend-spring-lake-3890
```

---

## Step 3: Verify the app is still running (minute 10–15)

After revoking, confirm the app redeployed successfully:

```sh
# Should return { "status": "ok" }
curl https://api.trygrowthproject.com/api/health
```

If the health check fails, check Fly logs:

```sh
fly logs -a backend-spring-lake-3890
```

---

## Step 4: Audit for misuse (minutes 15–60)

After the revocation, investigate whether the exposed secret was actually misused.

**For DATABASE_URL / SUPABASE_SERVICE_ROLE_KEY:**

Check Supabase logs for unusual queries or data exports:
- Supabase dashboard → Logs → Database logs
- Look for: bulk exports (`SELECT * FROM users`), deletions, or logins from unfamiliar IPs

**For STRIPE_SECRET_KEY:**

Check Stripe dashboard → Developers → Events:
- Look for: unexpected refunds, new customers, payment method changes, plan downgrades
- Sort by "most recent" and filter for the window when the key was exposed

**For JWT_SIGNING_KEY:**

Check for unusual admin actions in the audit log:
```sh
curl -s https://api.trygrowthproject.com/api/admin/reports/audit \
  -H "Authorization: Bearer YOUR_ADMIN_JWT" \
  -G --data-urlencode "since_days=1" | jq .
```

Look for: unknown user IDs, owner-role promotions, bulk data exports, GDPR deletion events.

**For FLY_API_TOKEN:**

Check GitHub Actions audit log:
- GitHub → Settings → Security → Audit log
- Filter for: `workflow_run`, unexpected deploys, changes to workflow files

---

## Step 5: Remove the exposed secret from wherever it was found

**Git commit:**

If the secret was committed to git, you must remove it from git history:

```sh
# This rewrites history — coordinate with Bradley before running
git filter-repo --path .env --invert-paths

# OR for a specific file
git filter-repo --path-match '<path-to-file-with-secret>' --invert-paths

# Force push (requires repo admin)
git push origin main --force
```

After force-pushing, anyone who has cloned the repo needs to re-clone it. The old commits are gone from the repo but may still exist in forks, GitHub search cache, or anyone's local clone. GitHub Support can help purge the cached content.

**Slack/email:**

Contact the channel admin to delete the message or email. Note: the exposure already happened — the goal is cleanup, not prevention at this point.

---

## Step 6: Record the incident

After the immediate response, write a brief incident report. This does not need to be formal — it just needs to capture what happened so it cannot happen again.

Minimum content:
- What secret was exposed
- When it was exposed (first known exposure time)
- How it was exposed (commit, paste, log line, etc.)
- When it was revoked
- Whether any misuse was detected

Store this in `docs/incidents/YYYY-MM-DD-secret-name-exposed.md` (create the folder if it doesn't exist). Do not include the secret value in the report.

---

## Step 7: Record the rotation in the audit log

```sh
curl -X POST https://api.trygrowthproject.com/api/admin/secrets/SECRET_NAME/rotation-log \
  -H "Authorization: Bearer YOUR_ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"notes": "Incident response rotation — see docs/incidents/YYYY-MM-DD-..."}'
```

---

## After the incident: prevent recurrence

Common root causes and fixes:

| How it happened | Prevention |
|---|---|
| `.env` file committed to git | Add `.env` to `.gitignore` immediately. Use `git secret` or similar tooling. |
| Pasted in Slack | Use Slack's "secret" message type for sensitive values. Use 1Password shared vaults instead. |
| Logged in an error message | Route all error messages through `redactSecrets()` from `src/common/redact-secrets.ts`. |
| Old dev machine had access | Revoke developer access when someone leaves; rotate shared secrets periodically. |
| Exposed in an HTTP response | Audit your API responses — never include raw connection strings or keys in API output. |

---

## Emergency contacts

- Fly.io support: https://community.fly.io / support@fly.io
- Supabase support: https://supabase.com/support
- Stripe support: https://stripe.com/contact (use the "Security issue" category)
- Sentry support: https://sentry.io/contact/support/

---

*This incident runbook is part of Phase 10 (Secrets Rotation) of The Growth Project backend. Review and update it annually or after any incident.*
