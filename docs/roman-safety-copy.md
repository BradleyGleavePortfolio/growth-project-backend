# Roman safety copy and guardrails (R4)

Source: `src/roman/guardrails/*`. Tests: `test/roman/roman-guardrails.spec.ts`.
Prompt version: `roman-client-v2`.

Owner ruling 2026-09-30 16:38: the safety copy is warm and composed
("butlered"), gives genuinely useful general, non-diagnostic guidance and a
safe next step inside the client's own plan, offers to message the coach, and
then gives the physician line. 911 and 988 routing is unchanged.

## Deterministic templates (no model call; `model_id = safety-router`)

**emergency** (chest pain, trouble breathing, fainting, etc.)

> Please stop what you are doing and call 911 now, or your local emergency number. If you are able, stay where you are, unlock the door, and keep your phone within reach so help can find you quickly. This is beyond what I can help with, and it should not wait. Once you are safe, your coach would want to hear from you in Messages, and I will be here.

**self_harm**

> I am sorry you are carrying this, and I am glad you said it here rather than holding it alone. Please reach the 988 Suicide & Crisis Lifeline now: call or text 988 in the United States, any hour, and a trained person will answer. If you are in immediate danger, call 911. If you can, let someone you trust know where you are so they can sit with you. You matter, and talking to a person right now is the right next step.

These two templates cost nothing (no model call, no spend), so a crisis
message is answered even when the caller has used every Roman turn (429) or
the daily spend cap is reached (503 `ROMAN_CAPACITY_REACHED`), when the
client has not granted box 2 (no client data is sent to the AI processor for
a template), and when no AI provider is configured. Every other turn keeps
the box-2 gate (403 `ai_consent_required`), the turn limit and the cap.

## Router hints (appended to SESSION STATE; the model composes the reply)

**medical_scope**: stay within general fitness and nutrition; never interpret,
diagnose or advise on the medical matter, never change or time medication.
Order: (1) general non-diagnostic principle (conversational effort, build
intensity gradually, water through the day, regular meals with protein, no
sharp food/water/training changes around a medication without the prescriber);
(2) one safe step inside the current plan (today's session as written or at a
lower intensity, keep logging, hold the coach-set targets); (3) offer to help
message the coach; (4) exact closing line:

> For the medical side of it, please check with your physician.

**injury_pain**: never diagnose, name a condition or prescribe rehab. Order:
(1) stop the movement that hurts today, pain is not effort; (2) a pain-free
alternative or lower-intensity version of the same session (bodyweight or
machine version, smaller range of motion, less load, or a walk and gentle
mobility); mild soreness a day or two after training is normal, sharp, joint or
persistent pain is a reason to stop; (3) rest the area today and keep movement
pain-free; (4) offer to help message the coach; (5) exact closing line:

> If it persists, gets worse, or is severe, please see a physician.

The post-check adds the matching line when a `medical_scope` / `injury_pain`
reply omits it, and rewrites diagnosis language or banned substances to the
templates in `roman-post-check.ts` (same shape: useful step, coach, physician).
