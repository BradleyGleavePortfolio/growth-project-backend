/**
 * B-R3-1 — the production consultation / safety-screen source for Roman's
 * per-turn grounding. Reads the client's OWN onboarding intake (#607,
 * `ClientOnboardingIntake`, one row per client) and turns it into the
 * question / answer pairs the coach consultation view already shows
 * (`buildConsultationView`), so Roman and the coach read the same answers.
 *
 * Scope: only the row whose `client_id` is the caller. Consent (P0) answers
 * are not repeated; screening answers are kept separately with `flagged` on a
 * "yes", and `clearance_recommended` is the intake's own `screening_any_yes`.
 *
 * Failure: a read failure THROWS. The context builder then fails, and
 * RomanService answers the turn in its explicit degraded mode (no personal
 * facts, no intensity step-ups), never as if the screen were clear.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { buildConsultationView } from '../../onboarding/consultation-view';
import type { Answers } from '../../onboarding/consultation-answers';
import type {
  RomanConsultationSummary,
  RomanCtxQA,
  RomanSafetyIntakeSource,
} from './roman-client-context.types';

const NOT_ANSWERED = 'Not answered';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
      .filter((a) => a.answer_label && a.answer_label !== NOT_ANSWERED)
      .map((a) => ({ question: a.question, answer: a.answer_label }));
    const screenAnswers: RomanCtxQA[] = view.screening.items
      .filter((i) => i.answer !== null)
      .map((i) => ({
        question: i.question,
        answer: i.note ? `${i.answer === 'yes' ? 'Yes' : 'No'}. ${i.note}` : i.answer === 'yes' ? 'Yes' : 'No',
        ...(i.answer === 'yes' ? { flagged: true } : {}),
      }));
    const screenAnswered = view.screening.items.some((i) => i.answer !== null);
    return {
      safety_intake: {
        completed: screenAnswered,
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
