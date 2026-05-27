# UX/UI Review Rubric — TGP Core Ideals

Three core ideals (user-stated):
1. **PREMIUM** — feels like Apple/Stripe/Linear-grade craft. Restrained, intentional, high-fidelity.
2. **REWARDING** — every interaction produces a satisfying micro-payoff. Behavioral design that builds habit without manipulation.
3. **COGNITIVELY SIMPLE EVEN WITH SO MUCH FUNCTIONALITY** — Apple's de-load doctrine: complexity hidden, never eliminated. One primary action per screen. Progressive disclosure.

## Source documents (READ BEFORE GRADING)
- `/home/user/workspace/Mobile-App-Design-Intelligence-Exhaustive-Agent-Training.md` (134 KB) — for all mobile screens
- `/home/user/workspace/Website-Landing-Page-Design-Intelligence-The-Exhaustive-Agent-Training-Document.md` (81 KB) — for all platform-site pages

## Per-screen rubric

Score each screen on three dimensions, 1–5 each (5 = matches Apple/Stripe/Linear; 1 = generic / cheap / overwhelming):

### A. PREMIUM (visceral first-impression)
- Spatial density — generous white space, not cramped
- Typographic character — intentional type, hierarchy, restraint
- Color/contrast — palette discipline, dark mode handled
- Production quality — illustrations, photos, icons feel curated
- Motion — purposeful, never gratuitous

### B. REWARDING (behavioral payoff)
- Micro-interactions — haptics, sound, animation on key actions
- Progress reflection — does the user SEE what they accomplished?
- Variable reward magnitude — not flat reinforcement
- Closure / completion drive — Apple Ring / Strava finish-line feel
- Streak/habit hooks where appropriate, not desperate

### C. COGNITIVELY SIMPLE (Apple de-load doctrine)
- One primary action per screen (no decision paralysis)
- Progressive disclosure — advanced features hidden until needed
- Information hierarchy — F/Z-pattern respected
- Touch targets ≥ 44pt, thumb-zone optimized
- Empty states — guide, don't punish
- Error recovery — graceful, never dead-end

### Overall verdict
- A: 13–15 = Decacorn quality
- B: 10–12 = Solid but room to lift
- C: 7–9 = Needs work
- D: ≤6 = Rebuild

## Output format per screen
```
### <directory>/<ScreenName>.tsx
- Premium: N/5 — <one line why>
- Rewarding: N/5 — <one line why>
- Cognitively Simple: N/5 — <one line why>
- Overall: A/B/C/D
- Top 1 fix: <single highest-leverage change>
```

## Report-level deliverables
1. **Executive heatmap** — table grouped by directory with avg scores per dimension
2. **Top 10 worst screens** — ranked by lowest overall score, with full per-screen rubric
3. **Top 10 strongest screens** — these set the bar; reference patterns for others
4. **Cross-cutting findings** — patterns of weakness or strength that span multiple screens
5. **Top 20 highest-leverage fixes** — prioritized by impact × frequency
6. **Per-section heatmap** — applicant/auth/client/coach/day-one/messaging/notifications/onboarding/settings/share/support + platform-site
