---
title: Help-content decisions log
audience: operators, future writers
status: append-only
---

# Help-content decisions log

This log records non-obvious editorial and structural decisions made
while authoring `docs/help/` and `docs/emails/onboarding/`. Append
new decisions to the bottom — never edit a past entry; supersede it
with a new one and link back.

The point of the log is to spare a future writer the round trip of
re-deriving why a piece of copy reads the way it does. If a decision
is obvious from the file's content, it does not belong here.

## Decisions

### 2026-04-30 — Tone is quiet-luxury, not casual

The Growth Project's audience is professional coaches who charge
premium rates and the clients those coaches recruit. Help content
matches that register: short paragraphs, declarative sentences, no
exclamation marks, no "we're here to help!" outros, no hedging
("just", "simply", "easy"). The reader's time is the cost we are
optimizing.

**Applies to:** every file in `docs/help/` and the email sequence.

### 2026-04-30 — No emoji anywhere

Emoji read as casual and date faster than prose. They are excluded
from copy, headings, and email subject lines. This is a hard rule,
not a preference — a reviewer can reject a PR on this alone.

### 2026-04-30 — No placeholder text

`TODO`, `FIXME`, `Coming soon`, `[insert X]`, and lorem-ipsum are not
allowed in committed help content. If a section cannot be written
because the underlying behavior is undecided, omit the section. A
missing page is a clean signal; a placeholder page is noise that ages
into a lie.

### 2026-04-30 — Tokens over values

Every deployment-specific value (email, URL, sender name) is a token
defined in `_tokens.md`. The motivation is reproducibility: the help
content should compile cleanly against staging, production, and a
future white-label deployment without a single edit to the prose.

### 2026-04-30 — No AI fingerprints

Avoid the dead-giveaway phrases that mark machine-generated copy:
"In today's fast-paced world", "delve", "leverage", "unlock", "robust",
"seamless", "elevate your X", "we're excited to". Also no rhetorical
tricolons ("clearer, faster, smarter"). When in doubt, shorter.

### 2026-04-30 — Boundaries are stated, not negotiated

The support-boundaries page tells coaches what we will and will not
do. It is a contract, not a negotiation, so it reads as a contract:
flat list, no softening adverbs, no "in most cases". Either it is in
scope or it is not.

### 2026-04-30 — Onboarding sequence is opt-in by behavior, not by send

Email N+1 is gated on the coach completing the action email N asked
for. We do not blast the full sequence on a fixed cadence. The
frontmatter on each email captures the trigger condition; the ESP
implementation enforces it. This decision drives the structure of
the email files (one trigger per file, no compound triggers).

### 2026-04-30 — One canonical action per email

Every onboarding email has exactly one call-to-action button or link.
Adding a second one halves the click-through rate of the first and
muddles the trigger model above. Secondary information lives in
inline prose without a link.

### 2026-04-30 — Help pages are self-contained

A coach reading the FAQ should not need to chase a chain of links to
get an answer. Each help page restates the small amount of context it
needs. Cross-links are for *related* pages, not *prerequisite* pages.

### 2026-04-30 — Status and incidents live at `${STATUS_URL}`, not in docs

When the platform is degraded, help content does not change — the
status page does. Help content links to `${STATUS_URL}` exactly once
(in `support-boundaries.md`) so coaches know where to look without
the link being everywhere.
