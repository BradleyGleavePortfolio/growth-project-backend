AUDIT Claude Opus 5.5 — growth-project-mobile#387 @ b54bea80c5c9948ec71465d4361dd0a1f36d76f7 — VERDICT: APPROVE

Lens AUD-OPUS-W2B-123 (agent 123), job INV1 piece 2. Full review at the exact head against backend main e6f9a5ec (src/invite-codes/coach-code-tools.{controller,service,dto,feature}.ts, auth/coach.guard.ts). Required checks green at this head (Typecheck, lint, test; CodeQL). Size 1,168 changed lines excluding the one-line lockfile entry (under 1,500). Conventional Commits title, tier header present, no new casts to any/unknown/never, no empty catch, copy has no first person.

**A: 0 | B: 0 | C: 3**

### Checked
- Flag off is invisible: `CoachCodesEntry` (route `InviteCodes`) calls GET /coach/codes; the backend answers 404 `coach_code_tools_disabled` (coach-code-tools.feature.ts) and `isCodeToolsDisabled` shows the legacy `InviteCodesScreen` unchanged (same `navigation` prop it always took; it reads no route params). A non-404 failure shows a retry line, never a silent fallback.
- Contract: list / signups / create / rotate / revoke paths, bodies and response shapes match the controller, DTOs (`label` <= 60, `max_uses` >= 1, `expires_at` ISO, `grace_hours` 0-168, `expected_code` for `coach-link`) and CoachCodeView / signups `by_code` (`today`, `unusual_today`). Tenancy is server-side from req.user.id; CoachGuard is coach/owner.
- Create sends an Idempotency-Key minted per attempt and reused on retry; editing a field drops it.
- Turn off: confirmation Alert, not offered on the coach link (server 409 `coach_link_not_revocable` covered in copy). Rotate: grace sheet (0 / 24 h / 7 days), coach link sends `expected_code`; a retiring code can only be turned off.
- QR: independently decoded the toqr matrix with OpenCV QRCodeDetector at this head: `https://app.trygrowthproject.com/join/GP-7XQ9KM` (29x29) and a 33x33 longer link both decode to the exact input; black on white with a 4-module quiet zone. `toqr` 0.1.1 is a top-level, non-dev lockfile entry (MIT, pure JS, dist present for Metro's import/require conditions); no native module.
- Bulk invite (`CoachBulkInvite`) and Who joined (`InviteCodeRedeemers` with `inviteCodeId`, `code`) are in the same Clients stack as `InviteCodes`, so the flip removes nothing coaches use today.

### C (one line each)
- C-387-1 C (edge, deferred to 10k clients): a Create retry recomputes `expires_at` from the current time under the same Idempotency-Key.
- C-387-2: QR sheet line "Scanning opens The Growth Project with this code filled in" assumes the app is installed and universal links verified; otherwise the scan opens the /join web page. Consider "Scanning opens the sign-up link for this code."
- C-387-3: while the flag is off, opening Codes costs one extra GET /coach/codes (spinner) before the legacy screen; offline it shows a retry line instead of the legacy screen.
