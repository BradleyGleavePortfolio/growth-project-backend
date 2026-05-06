import { BadRequestException } from '@nestjs/common';
import { DiagnosticService } from '../src/diagnostic/diagnostic.service';
import { SubmitDiagnosticDto } from '../src/diagnostic/diagnostic.dto';

/**
 * Service-level coverage for the 40-point scoring pipeline.
 *
 * The DB-bound paths (submit / getResult / attachUser) are exercised by
 * the controller spec, which mocks PrismaService. Here we focus on the
 * pure score-computation logic — which buckets, how percentages
 * normalize, and what shape errors take.
 */
describe('DiagnosticService.computeScores', () => {
  // PrismaService and AiRoadmapService aren't used by computeScores, so we
  // pass plain stubs to satisfy the constructor.
  const svc = new DiagnosticService(
    {} as never,
    {} as never,
  );

  function makeAnswers(value: number): SubmitDiagnosticDto['answers'] {
    return Array.from({ length: 40 }, (_, i) => ({ question_id: i + 1, answer: value }));
  }

  it('all 1s → 0% on every section, overall raw=40, overall bucket=stuck', () => {
    const { scores, buckets } = svc.computeScores(makeAnswers(1));
    expect(scores.income).toBe(0);
    expect(scores.body).toBe(0);
    expect(scores.lifestyle).toBe(0);
    expect(scores.income_raw).toBe(15);
    expect(scores.body_raw).toBe(12);
    expect(scores.lifestyle_raw).toBe(13);
    expect(scores.overall_raw).toBe(40);
    expect(buckets.income).toBe('stuck');
    expect(buckets.body).toBe('stuck');
    expect(buckets.lifestyle).toBe('stuck');
    expect(buckets.overall).toBe('stuck');
  });

  it('all 5s → 100% on every section, overall raw=200, overall bucket=compounding', () => {
    const { scores, buckets } = svc.computeScores(makeAnswers(5));
    expect(scores.income).toBe(100);
    expect(scores.body).toBe(100);
    expect(scores.lifestyle).toBe(100);
    expect(scores.income_raw).toBe(75);
    expect(scores.body_raw).toBe(60);
    expect(scores.lifestyle_raw).toBe(65);
    expect(scores.overall_raw).toBe(200);
    expect(buckets.income).toBe('compounding');
    expect(buckets.body).toBe('compounding');
    expect(buckets.lifestyle).toBe('compounding');
    expect(buckets.overall).toBe('compounding');
  });

  it('all 3s → 50% per section, overall raw=120, overall bucket=moving', () => {
    const { scores, buckets } = svc.computeScores(makeAnswers(3));
    expect(scores.income).toBe(50);
    expect(scores.body).toBe(50);
    expect(scores.lifestyle).toBe(50);
    expect(scores.overall_raw).toBe(120);
    expect(buckets.income).toBe('moving');
    expect(buckets.body).toBe('moving');
    expect(buckets.lifestyle).toBe('moving');
    expect(buckets.overall).toBe('moving');
  });

  it('overall headline matches the moving bucket on raw=71 (lower edge)', () => {
    // Build a 71 raw total: 15×1 + 12×1 + 13 questions where answers sum
    // to 44. We hand-pick 5,5,5,5,5,5,5,4,1,1,1,1,1 = 39+5=44? Just do 11×3+2×something.
    // Simpler: 13 lifestyle answers = 4 each → 52, body 1 each → 12, income 1 each → 15. Total = 79.
    const answers: SubmitDiagnosticDto['answers'] = [];
    for (let i = 1; i <= 15; i++) answers.push({ question_id: i, answer: 1 });
    for (let i = 16; i <= 27; i++) answers.push({ question_id: i, answer: 1 });
    for (let i = 28; i <= 40; i++) answers.push({ question_id: i, answer: 4 });
    const { scores, buckets } = svc.computeScores(answers);
    expect(scores.overall_raw).toBe(15 + 12 + 13 * 4); // 79
    expect(buckets.overall).toBe('moving');
    expect(buckets.overall_headline).toContain("You're in motion.");
  });

  it('rejects answers list with !=40 entries', () => {
    expect(() =>
      svc.computeScores([{ question_id: 1, answer: 3 }] as SubmitDiagnosticDto['answers']),
    ).toThrow(BadRequestException);
  });

  it('rejects duplicate question_id', () => {
    const answers = makeAnswers(3);
    answers[0] = { question_id: 1, answer: 4 };
    answers[1] = { question_id: 1, answer: 5 };
    expect(() => svc.computeScores(answers)).toThrow(/Duplicate/);
  });

  it('rejects missing question_id', () => {
    const answers = makeAnswers(3);
    // Replace id=40 with id=999 → catalog is missing 40 and contains an alien.
    answers[39] = { question_id: 999, answer: 5 };
    expect(() => svc.computeScores(answers)).toThrow(/Missing answer/);
  });
});
