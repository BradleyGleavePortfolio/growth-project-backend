/**
 * B-R3-1 — the production consultation / safety-screen source for Roman's
 * per-turn grounding. Reads the client's OWN onboarding intake (#607,
 * `ClientOnboardingIntake`, one row per client) and turns it into the
 * question / answer pairs the coach consultation view already shows
 * (`buildConsultationView`), so Roman and the coach read the same answers.
 *
 * Scope: only the row whose `client_id` is the caller. Consent (P0) answers
 * are not repeated; screening answers are kept separately with `flagged` on a
 * "yes", and `clearance_recommended` is the intake's own `screening_any_yes`
 * (or any "yes" already saved, even on a partial screen).
 *
 * B-667-1: the coach view shows the date-of-birth answer (B2) as the full
 * date plus age. Roman gets the whole age only, never the date.
 * B-667-2: the screen counts as completed only when every screening question
 * (P1-P7) has a yes/no answer; a partial screen keeps its answers but stays
 * `completed:false`, so the builder still reports `intake` as missing.
 *
 * Failure: a read failure THROWS. The context builder then fails, and
 * RomanService answers the turn in its explicit degraded mode (no personal
 * facts, no intensity step-ups), never as if the screen were clear.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { ageInYears } from '../../macros/macro-calculator';
import { buildConsultationView } from '../../onboarding/consultation-view';
import { SCREENING_KEYS, type Answers } from '../../onboarding/consultation-answers';
import type {
  RomanConsultationSummary,
  RomanCtxQA,
  RomanSafetyIntakeSource,
} from './roman-client-context.types';

const NOT_ANSWERED = 'Not answered';
/** B-667-1: the date-of-birth screen. */
const DOB_SCREEN = 'B2';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Whole years from a stored YYYY-MM-DD birth date; null when it is not one. */
function wholeAgeOf(v: unknown, now: Date): number | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const dob = new Date(`${v}T00:00:00.000Z`);
  if (Number.isNaN(dob.getTime())) return null;
  const age = ageInYears(dob, now);
  return age >= 0 && age < 130 ? age : null;
}

@Injectable()
export class RomanConsultationIntakeSource implements RomanSafetyIntakeSource {
  constructor(private readonly prisma: PrismaService) {}

  async summarize(userId: string, now: Date = new Date()): Promise<RomanConsultationSummary> {
    const row = await this.prisma.clientOnboardingIntake.findUnique({
      where: { client_id: userId },
      select: {
        client_id: true,
        version: true,
        answers: true,
        current_revision: true,
        disclaimer_version: true,
        disclaimer_accepted_at: true,
        screening_any_yes: true,
        saved_at: true,
        completed_at: true,
        created_at: true,
      },
    });
    if (!row || row.client_id !== userId) {
      return {
        safety_intake: { completed: false, clearance_recommended: false, screen_answers: [] },
        consultation: { completed: false, completed_at: null, answers: [] },
      };
    }
    const answers: Answers = isRecord(row.answers) ? (row.answers as Answers) : {};
    const view = buildConsultationView(
      {
        version: row.version,
        revision: row.current_revision,
        cause: 'roman_context',
        answers,
        disclaimer_version: row.disclaimer_version,
        disclaimer_accepted_at: row.disclaimer_accepted_at,
        screening_any_yes: row.screening_any_yes,
        created_at: row.created_at,
      },
      { submitted_at: row.completed_at, saved_at: row.saved_at },
      now,
    );
    const consultationAnswers: RomanCtxQA[] = view.chapters
      .flatMap((c) => c.answers)
      .flatMap((a): RomanCtxQA[] => {
        if (a.screen === DOB_SCREEN) {
          const age = wholeAgeOf(answers[DOB_SCREEN], now);
          return age === null ? [] : [{ question: 'Age', answer: `${age} years` }];
        }
        if (!a.answer_label || a.answer_label === NOT_ANSWERED) return [];
        return [{ question: a.question, answer: a.answer_label }];
      });
    const screenAnswers: RomanCtxQA[] = view.screening.items
      .filter((i) => i.answer !== null)
      .map((i) => ({
        question: i.question,
        answer: i.note
          ? `${i.answer === 'yes' ? 'Yes' : 'No'}. ${i.note}`
          : i.answer === 'yes'
            ? 'Yes'
            : 'No',
        ...(i.answer === 'yes' ? { flagged: true } : {}),
      }));
    const answered = new Set(
      view.screening.items.filter((i) => i.answer !== null).map((i) => i.key),
    );
    const screenComplete = SCREENING_KEYS.every((k) => answered.has(k));
    return {
      safety_intake: {
        completed: screenComplete,
        clearance_recommended: row.screening_any_yes === true || view.screening.any_yes,
        screen_answers: screenAnswers,
      },
      consultation: {
        completed: row.completed_at !== null,
        completed_at: row.completed_at ? row.completed_at.toISOString() : null,
        answers: consultationAnswers,
      },
    };
  }
}
