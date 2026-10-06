Tier: T1
Why: Correct one false customer-facing support-channel claim in static help copy.
T4 trigger scan: None. No authentication, access control, PII handling, money, credentials, data writes or destructive operations changed.
T3 trigger scan: None. Static HTML/documentation copy and a focused renderer test only; no schema or API contract changes.
Bounded T1: One contact-page footnote and its canonical documentation describe existing support routes.
Canonical builder: GPT-6.1 Sol, AUDIT-19-125, agent 125.
Acceptance evidence: Focused test asserts the app Settings -> Support route, existing support email, no phone line and no 24/7 promise. Tests-only main-baseline run [37530707188](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37530707188) fails both assertions. [Fixed-head PR CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37530931015) is green at 1f32a2c1cd7ba6f0e4d7db0c75c75102a6cc742e, including the new renderer spec.

## B fixed
- B19-1: An ordinary user opens Help -> Contact support and is falsely told there is no chat and email is the only support channel despite the app offering human support chat; the page now describes Settings -> Support when available, and email as an alternative.

## Overlap
- #784 also edits `src/public-pages/help-pages.html.ts`, but only the separate account-deletion instructions and last-reviewed date. This PR deliberately leaves those lines alone and changes only the contact-page footnote.
- No merge, deployment, production access, build or flag changes.
