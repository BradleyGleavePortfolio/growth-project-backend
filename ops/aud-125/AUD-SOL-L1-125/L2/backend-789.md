AUDIT GPT-6.1 Sol — growth-project-backend#789 @ a28c474c8ed4fe9e23535458b5d91071cf45d4b7 — VERDICT: APPROVE

A=0 B=0 C=0.

Both existing authorized thread-read paths now mark only the reader's unread `message_received` notification rows with that client's exact thread deep link, and a notification update failure is logged without failing the message read ([messaging.service.ts:1020–1090](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/a28c474c8ed4fe9e23535458b5d91071cf45d4b7/src%2Fmessaging%2Fmessaging.service.ts#L1020-L1090)).

The regression covers coach and client readers, another thread, and best-effort failure; build-and-test, R75 and CodeQL are green at this head ([read-state regression](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/a28c474c8ed4fe9e23535458b5d91071cf45d4b7/test%2Fmessaging%2Fmessaging-read-clears-notifications.spec.ts), [build-and-test](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37532616731/job/112505512112), [R75](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37532616848/job/112505511762), [CodeQL](https://github.com/BradleyGleavePortfolio/growth-project-backend/runs/112507030780)).

No launch-blocking finding in this change ([PR diff](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/789)).
