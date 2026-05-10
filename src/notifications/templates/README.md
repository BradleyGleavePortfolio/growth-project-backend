# Notification Email Templates

Handlebars templates for all digest emails. Templates live at `src/notifications/templates/`. `DigestService` compiles them at module init and renders them at send time.

---

## Template Library

| File | Purpose | Subject line pattern |
|---|---|---|
| `digest-client.hbs` | Client daily summary | `Your daily summary — {date}` |
| `digest-coach.hbs` | Coach daily summary | `{N} clients need review today — {date}` or `Your coach summary — {date}` |
| `digest-client-weekly.hbs` | Client weekly summary | `Your week in numbers — {N}% check-in consistency` |
| `digest-coach-weekly.hbs` | Coach weekly summary | `{N} clients need check-in this week — your weekly summary` |

Subject lines use numbers over adjectives. "3 clients need check-in this week" not "Some clients need attention".

---

## Design Doctrine

- Bone/ink/oxblood palette: background `#f5f1eb`, text `#1a1a1a`, accent `#6b0f1a`.
- Display font: Georgia (web-safe serif, approximates Cormorant Garamond).
- Body font: system serif stack.
- No emoji anywhere in templates.
- No hype, no exclamation marks, no motivational filler copy.
- Every number is a real value from the database — no synthetic or placeholder numbers.

---

## Template Variables

### digest-client.hbs

| Variable | Type | Description |
|---|---|---|
| `date` | string | Formatted date, e.g. "7 May 2026" |
| `checkins` | `{label, value}[]` | Check-in metrics to display |
| `weightMetrics` | `{label, value}[]` | Weight metrics (empty array if no logs) |
| `streakMetrics` | `{label, value}[]` | Streak data |
| `coachName` | string? | Coach's first name only. Null = no coach assigned |
| `appUrl` | string | CTA button destination |
| `unsubscribeUrl` | string | Unsubscribe link |
| `currentYear` | string | Footer year |

### digest-coach.hbs

| Variable | Type | Description |
|---|---|---|
| `date` | string | Formatted date |
| `rosterStats` | object | `{ activeCount, checkinsToday, needingReview, unreadMessages }` |
| `alertClients` | `{displayName, reason}[]` | First name only — never full name or raw metrics |
| `recentWins` | `{displayName, win}[]` | Empty array until CommunityWin query is wired |
| `consoleUrl` | string | Coach console CTA |
| `unsubscribeUrl` | string | Unsubscribe link |
| `currentYear` | string | Footer year |

### digest-client-weekly.hbs

| Variable | Type | Description |
|---|---|---|
| `date` | string | Week-ending date |
| `weekStats` | object | `{ checkinsCount, consistencyPct, workoutsCount, weightDelta? }` |
| `streaks` | object | `{ current, best }` |
| `nextFocus` | string? | Plain-text focus paragraph for coming week |
| `appUrl` | string | CTA button destination |
| `unsubscribeUrl` | string | Unsubscribe link |
| `currentYear` | string | Footer year |

### digest-coach-weekly.hbs

| Variable | Type | Description |
|---|---|---|
| `date` | string | Week-ending date |
| `rosterStats` | object | `{ activeCount, weeklyCheckinsCount, avgConsistencyPct, needCheckin }` |
| `topPerformers` | `{displayName, highlight}[]` | First name + plain-text highlight |
| `needingAttention` | `{displayName, reason}[]` | Clients without check-in this week |
| `consoleUrl` | string | Coach console CTA |
| `unsubscribeUrl` | string | Unsubscribe link |
| `currentYear` | string | Footer year |

---

## Privacy Rules in Templates

- **Client templates**: only the client's own data. Coach name is first name only.
- **Coach templates**: client display names are first-name only (derived by splitting on space). No weight values, no income figures, no body metrics from any client appear in the template. Counts only ("3 clients need check-in").

---

## Future Work

- Add text/plain fallback parts for each template (currently HTML-only).
- Add open-tracking pixel (opt-in, GDPR-compliant) for delivery analytics.
- Render preview screenshots via Puppeteer on each template change and commit them alongside this README.
