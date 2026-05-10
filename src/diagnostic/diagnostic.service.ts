import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AiRoadmapService } from './ai-roadmap.service';
import {
  DiagnosticBuckets,
  DiagnosticScores,
  ResultResponse,
  RoadmapPayload,
  RoadmapStatus,
  SubmissionResponse,
  SubmitDiagnosticDto,
} from './diagnostic.dto';
import {
  loadCatalog,
  overallBucket,
  questionIdsBySection,
  sectionBucket,
} from './question-catalog';

/**
 * DiagnosticService — owns the 40-question scoring pipeline.
 *
 *   1. Validate the answer set covers each catalog id exactly once.
 *   2. Compute section sums + the overall raw total.
 *   3. Bucket each section + the overall band per the brief's cutoffs.
 *   4. Persist a DiagnosticSubmission row.
 *   5. Kick off the async AI roadmap (fire-and-forget). Failures land as
 *      AiRoadmap{status='failed'} rows; the user sees a retry path, never a 5xx.
 */
@Injectable()
export class DiagnosticService {
  private readonly logger = new Logger(DiagnosticService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRoadmap: AiRoadmapService,
  ) {}

  computeScores(answers: SubmitDiagnosticDto['answers']): {
    scores: DiagnosticScores;
    buckets: DiagnosticBuckets;
  } {
    const ids = questionIdsBySection();

    // Build a Map<id, value>. Reject duplicates and missing ids before scoring
    // so a malformed payload fails BEFORE any DB write.
    const byId = new Map<number, number>();
    for (const a of answers) {
      if (byId.has(a.question_id)) {
        throw new BadRequestException(`Duplicate question_id ${a.question_id}`);
      }
      byId.set(a.question_id, a.answer);
    }
    const allIds = [...ids.income, ...ids.body, ...ids.lifestyle];
    for (const id of allIds) {
      if (!byId.has(id)) {
        throw new BadRequestException(`Missing answer for question_id ${id}`);
      }
    }
    if (byId.size !== 40) {
      throw new BadRequestException(`Expected 40 answers, received ${byId.size}`);
    }

    const sumOf = (sectionIds: number[]): number =>
      sectionIds.reduce((acc, id) => acc + (byId.get(id) ?? 0), 0);

    const incomeRaw = sumOf(ids.income); // 15-75
    const bodyRaw = sumOf(ids.body); // 12-60
    const lifestyleRaw = sumOf(ids.lifestyle); // 13-65
    const overallRaw = incomeRaw + bodyRaw + lifestyleRaw; // 40-200

    // Normalize each section to a 0-100 percentage of its max. We subtract
    // the floor (n_questions * 1) so that "all 1s" maps to 0% rather than
    // 20% — matching the brief's "0-30% = STUCK" intent. A perfect score
    // (all 5s) maps to 100%.
    const norm = (raw: number, n: number): number => {
      const min = n;
      const max = n * 5;
      return ((raw - min) / (max - min)) * 100;
    };
    const incomePct = norm(incomeRaw, 15);
    const bodyPct = norm(bodyRaw, 12);
    const lifestylePct = norm(lifestyleRaw, 13);

    const overall = overallBucket(overallRaw);
    const buckets: DiagnosticBuckets = {
      income: sectionBucket(incomePct),
      body: sectionBucket(bodyPct),
      lifestyle: sectionBucket(lifestylePct),
      overall: overall.id,
      overall_headline: overall.headline,
    };

    const scores: DiagnosticScores = {
      income: round1(incomePct),
      body: round1(bodyPct),
      lifestyle: round1(lifestylePct),
      income_raw: incomeRaw,
      body_raw: bodyRaw,
      lifestyle_raw: lifestyleRaw,
      overall_raw: overallRaw,
    };
    return { scores, buckets };
  }

  async submit(
    body: SubmitDiagnosticDto,
    meta: { ip?: string; user_agent?: string },
  ): Promise<SubmissionResponse> {
    const { scores, buckets } = this.computeScores(body.answers);

    const submission = await this.prisma.diagnosticSubmission.create({
      data: {
        email: body.email.toLowerCase(),
        name: body.name ?? null,
        age: body.age ?? null,
        source: body.source ?? null,
        answers: body.answers as unknown as Prisma.InputJsonValue,
        scores: scores as unknown as Prisma.InputJsonValue,
        bucket: buckets as unknown as Prisma.InputJsonValue,
        ip: meta.ip ?? null,
        user_agent: meta.user_agent ?? null,
      },
      select: { id: true },
    });

    // Fire-and-forget. The promise is intentionally not awaited — the
    // controller returns submission_id immediately and the client polls
    // GET /diagnostic/:id until status='ready' or 'failed'.
    void this.aiRoadmap.generateAndPersist(submission.id, scores, buckets, body).catch((err) => {
      this.logger.warn(
        `ai-roadmap generation failed (caught) for submission=${submission.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

    return {
      submission_id: submission.id,
      scores,
      buckets,
      roadmap_status: 'generating',
    };
  }

  async getResult(submissionId: string): Promise<ResultResponse> {
    const row = await this.prisma.diagnosticSubmission.findUnique({
      where: { id: submissionId },
      include: { roadmap: true },
    });
    if (!row) {
      throw new NotFoundException('submission_not_found');
    }
    const scores = row.scores as unknown as DiagnosticScores;
    const buckets = row.bucket as unknown as DiagnosticBuckets;
    const roadmap = row.roadmap;

    let status: RoadmapStatus;
    let payload: RoadmapPayload | null;
    if (!roadmap) {
      status = 'generating';
      payload = null;
    } else if (roadmap.status === 'failed') {
      status = 'failed';
      payload = null;
    } else {
      status = 'ready';
      payload = (roadmap.payload as unknown as RoadmapPayload) ?? null;
    }

    return {
      submission: {
        id: row.id,
        submitted_at: row.submitted_at.toISOString(),
        scores,
        buckets,
      },
      roadmap: payload,
      roadmap_status: status,
    };
  }

  /**
   * GDPR/back-fill helper: when an anonymous lead later signs up with the
   * same email, the auth flow calls this to attribute prior submissions.
   * Append-only friendly — we set user_id but keep the historical email
   * intact for funnel analytics.
   */
  async attachUser(email: string, userId: string): Promise<number> {
    const result = await this.prisma.diagnosticSubmission.updateMany({
      where: { email: email.toLowerCase(), user_id: null },
      data: { user_id: userId },
    });
    return result.count;
  }

  /**
   * Returns the catalog (questions + sections + scale_label) without any PII.
   * Public surface — safe to call without auth.
   */
  getCatalog() {
    return loadCatalog();
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
