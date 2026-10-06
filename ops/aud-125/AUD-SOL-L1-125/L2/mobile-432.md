AUDIT GPT-6.1 Sol — growth-project-mobile#432 @ f3f7afbb3b1122ea2866a3ecc1f3bf5ee2db4c8b — VERDICT: APPROVE

A=0 B=0 C=0.

The missing-screen fallback sends community pushes to the Community tab, workout reminders to Workouts, and other recognized kinds to the notification center while preserving explicit targets and the existing role/feature checks ([push fallback](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/f3f7afbb3b1122ea2866a3ecc1f3bf5ee2db4c8b/src%2Fservices%2FpushNotifications.ts), [guarded route table](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/f3f7afbb3b1122ea2866a3ecc1f3bf5ee2db4c8b/src%2Fservices%2FpushTapRouter.ts)).

Inbox normalization similarly gives current message, community, workout and content rows a useful target without requiring a new backend payload ([notificationsApi.ts](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/f3f7afbb3b1122ea2866a3ecc1f3bf5ee2db4c8b/src%2Fservices%2FnotificationsApi.ts)).

Typecheck/lint/test and CodeQL are green at this head, and no launch-blocking finding remains in the change ([mobile CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37533500131/job/112508502958), [CodeQL](https://github.com/BradleyGleavePortfolio/growth-project-mobile/runs/112512862570)).
