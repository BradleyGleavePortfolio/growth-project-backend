# AUD-SOL-RA-121 — agent 121 cross-stack day-1 budget notice

Read-only check of the stack's last existing tree (`fb671019`, #670) found two live-turn omissions outside inert #667/#665. [Stack tail](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/670).

1. No `CoachAIBudgetService` or `recordUsage` in RomanService/RomanModule; every provider turn currently bypasses the existing monthly coach pool. [Live-turn owner #668](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668).
2. `src/roman/roman.service.ts:1183-1214,1224-1255` receives `caller`, but both daily aggregates filter only capability and UTC day, not requester/subject. The configured `ROMAN_DAILY_COST_CAP_USD` therefore caps all clients together, not each client separately. [Live-turn owner #668](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668).

Recommended default: assign both Bs to the live-turn owner before activation, combining atomic per-client admission with coach-pool admission/debit and conservative interrupted-turn settlement; distinct pool-empty/daily-cap copy. Do not block inert context PRs with findings owned outside their diff. This is independent read-only inspection, not a verdict on #668–#670.
