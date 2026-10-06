Tier: T4
Why: Apple 1.2 (UGC) store compliance: member reports must reach a moderator; this exposes the existing coach moderation queue (Hide / Warn / Ban / Dismiss) in the store build.
T4 trigger scan: store/legal compliance (Apple 1.2 report-and-respond) and a coach privilege surface (moderation actions). Server authorization is unchanged: GET /community/moderation/flagged is coach/owner only and scoped to the coach's own workspaces; PATCH /community/moderation/items/:id keeps assertModerator. No auth, money, PII-shape, schema or data change.
T3 trigger scan: none (reuses existing screens, hooks and routes; no new contract).
Bounded T1: NO (runtime behaviour and a privileged surface).
Canonical builder: Claude Opus 5.5 (AUDIT-10-125, agent 125)
Parent owner: operator agent 125
Acceptance evidence: new src/screens/coach/__tests__/CommunityReportsEntry.test.tsx (hidden on 503, count + navigation to ClientsStack/CoachCommunityModeration, no badge at zero); CommunitySpaceScreen.test.tsx new case (feed with posts shows New post -> CommunityComposer {mode:'post'}; fails on main, where the testID does not exist); coachCommunityScreens.test.tsx reason label assertions updated; full mobile CI on this PR.
Promotion triggers: any change to backend moderation authorization, or turning on the coach Community tab (its Home calls /community/coach/dashboard, which the backend does not serve).

Works against the CURRENT production backend (ec12a4b3): GET /community/moderation/flagged, PATCH /community/moderation/items/:id, GET /community/coach/empty-states and GET /community/posts/:id are all live with FEATURE_COMMUNITY_API on. If the community API is off (503) or the route is missing (404), the Reports entry hides (same probe pattern as BroadcastsEntry). No new flag.

## Fixes

- **B-1 (Apple 1.2, false claim)**: A client reports an abusive Hall post or comment; the report lands in the moderation queue, but the coach Community tab is off in the 10-07 build (EXPO_PUBLIC_FF_COACH_COMMUNITY unset), so no coach screen can open it and the "reviewed within 24 hours by your coach" promise in Community safety is not met. Fix: a "Reports" button with the open count in the coach Messages header (MessagesScreen and CoachInboxV2), opening the existing CoachCommunityModerationScreen and its post detail, now registered in the Clients stack. Header rows wrap so title + Reports + Broadcasts never clip on narrow phones.
- **B-2 (core community flow dead-ends)**: A client opens the Hall after anyone has posted and finds no way to write a post; the only composer entry was the empty state's "Be the first to post". Fix: a "New post" button above the feed in CommunitySpaceScreen (Hall and Cohorts).
- **U-1**: The report queue showed the stored reason code ("self_harm") to the coach. It now shows the label the member picked ("Self-harm or suicide").

Overlap: none with open PRs (m#402, m#404-m#415 touch no community or coach Messages header files; checked file lists).
