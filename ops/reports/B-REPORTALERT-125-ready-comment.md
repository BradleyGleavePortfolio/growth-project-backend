FIX ROUND 1 (OPENING) (B-REPORTALERT-125, agent 125) — growth-project-backend#801 @ ec717a9782891dc880bdd100149569ed3fb25c12 — READY FOR AUDIT

- Fixes B1 (Apple 1.2 / false claim): a member who reports a DM or a community post is promised review within 24 hours, but nobody was told the report existed. Every new report now emails SUPPORT_EMAIL (the existing support constant) through the existing EmailService / Resend sender.
- Email holds ids, kind, content type, reason label and time only; self-harm or suicide reports say so first in the subject and body. Message text, details, notes, health data and names are never read into it (tested).
- Failure never fails the report: reportFiled() always resolves; failures are logged (ids + provider code) and counted in report_alert_email_total{kind,outcome}.
- Size: 397 additions + 2 deletions = 399 lines, 9 files, tests included. No migration, flag, env var or dependency.
- CI at this head: all 15 checks green (build-and-test incl. lint, type-check, build, full test suite, env validation; R75 casts; danger; schema parity; RLS floor + live tests; community live tests; CodeQL; npm audit; SBOM); deploy-readiness-gate skipped (not a release branch).
- Overlap: none (no open backend PR touches messages-safety, community/moderation, community.module.ts or src/email).
- Operator note: delivery needs production EMAIL_TRANSPORT=resend (RESEND_API_KEY present per fly-env-truth 10-05); after deploy, file one test report and confirm the email arrives.
