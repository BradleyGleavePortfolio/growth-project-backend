AUDIT Claude Opus 5.5 — growth-project-backend#754 @ 584b3c979ecee0c675758e3714f56b63536a6f78 — VERDICT: APPROVE

Lens AUD-OPUS-W2B-123 (agent 123), queue R3C item 4 (F2 B-GUIDEPOOL; READY FOR AUDIT comment 6010047298). Full review of the 465-line diff against main (read at 8413701a), plus the delta 8413701a..584b3c97 (the two pool-failure logs now record only the error class, not the message) (src ai.service.ts + ai.controller.ts, new spec). All required checks green at this head. No new casts to any/unknown/never, no empty catch, no schema change.

**A: 0 | B: 0 | C: 3**

### Checked
- Order in `chat()`: the crisis classifier still runs first and returns the fixed safety reply before consent, quota or the pool, so a person in crisis is never told "credits used up" (spec: "a crisis message gets the safety reply and never touches the pool"). The pool check then runs before the daily quota reservation and before any provider call, so a pool-empty reply spends nothing and uses no quota.
- Attribution matches Roman: a client is billed to `resolveHeadCoachId(coach_id)` (a sub-coach's client goes to the head coach); a coach or sub-coach to their own head pool; the owner and a client with no coach have no pool. The pre-check uses an upper bound (UTF-8 bytes + 256 framing tokens in, `MAX_TOKENS_PER_CALL` out at $3/$15 per MTok, rounded up) on the exact clamped text that is sent (`providerUser` is now built once and reused for the call).
- Debit: reported provider tokens (including usage with no text) are rounded up to cents and debited through the existing atomic `recordUsage`. A short pool consumes the remainder so the next question gets the fixed reply. A debit failure is logged, never thrown, because the answer was already produced. A pool read failure fails closed with coded 503 `AI_GUIDE_CREDITS_UNAVAILABLE` and plain copy.
- Shipped app: the pool-empty case is a 200 with fixed copy (`model_used: 'credits'`, `code: COACH_AI_BUDGET_EXHAUSTED`), so today's AIGuideScreen shows the words instead of its generic service error. I agree with the builder's operator default (keep the 200). The client copy and coach copy are plain and say what still works.

### C (one line each)
- C-754-1 (policy): coachless clients and the owner have no pool; their Guide use is bounded only by the per-person daily token quota (same as Roman).
- C-754-2 (time edge): between a period's end and the rollover scheduler run, the pre-check can pass while `recordUsage` refuses the debit (logged, answer free).
- C-754-3 (race edge): two answers in flight at once can each pass the pre-check; the second debit consumes only the remainder (overshoot of at most one answer).
