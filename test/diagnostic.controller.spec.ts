import { Test, TestingModule } from '@nestjs/testing';
import { DiagnosticController } from '../src/diagnostic/diagnostic.controller';
import { DiagnosticService } from '../src/diagnostic/diagnostic.service';
import { AiRoadmapService } from '../src/diagnostic/ai-roadmap.service';
import { PrismaService } from '../src/prisma.service';
import { SubmitDiagnosticDto } from '../src/diagnostic/diagnostic.dto';

/**
 * Light controller-level coverage. Rate-limit enforcement is exercised
 * elsewhere (test/redis-throttler.spec.ts + test/throttler.module.spec.ts);
 * here we just check the wiring: PUBLIC routes return the catalog, submit
 * persists + returns submission_id, GET fetches.
 */
describe('DiagnosticController', () => {
  let controller: DiagnosticController;

  // Minimal in-memory Prisma double tailored to the controller's needs.
  function makePrismaStub() {
    const submissions = new Map<string, any>();
    return {
      diagnosticSubmission: {
        create: jest.fn(async ({ data, select }: any) => {
          const id = `sub_${submissions.size + 1}`;
          submissions.set(id, { id, ...data, submitted_at: new Date() });
          return select?.id ? { id } : submissions.get(id);
        }),
        findUnique: jest.fn(async ({ where }: any) => {
          const row = submissions.get(where.id);
          if (!row) return null;
          return { ...row, roadmap: null };
        }),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      aiRoadmap: {
        upsert: jest.fn(async () => ({})),
      },
    };
  }

  beforeEach(async () => {
    const prismaStub = makePrismaStub();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DiagnosticController],
      providers: [
        DiagnosticService,
        AiRoadmapService,
        { provide: PrismaService, useValue: prismaStub },
      ],
    }).compile();
    controller = module.get(DiagnosticController);
  });

  function makeAnswers(value: number): SubmitDiagnosticDto['answers'] {
    return Array.from({ length: 40 }, (_, i) => ({ question_id: i + 1, answer: value }));
  }

  it('GET /diagnostic/questions returns the catalog without PII', () => {
    const catalog = controller.getQuestions();
    expect(catalog.questions).toHaveLength(40);
    expect(catalog.sections).toHaveLength(3);
    expect(catalog.scale_label).toContain('Strongly disagree');
    // Spot-check the first income question is verbatim from the brief.
    const q1 = catalog.questions.find((q) => q.id === 1);
    expect(q1?.text).toBe(
      "Do you have a primary income source that doesn't require your physical presence?",
    );
    // The catalog must NOT echo back any kind of email / answer field.
    expect(JSON.stringify(catalog)).not.toMatch(/email|answer/i);
  });

  it('POST /diagnostic/submit returns submission_id + scores + buckets immediately', async () => {
    const body: SubmitDiagnosticDto = {
      email: 'lead@example.com',
      name: 'Lead',
      answers: makeAnswers(3),
    };
    const res = await controller.submit(body, {
      headers: { 'x-forwarded-for': '203.0.113.5', 'user-agent': 'jest-test' },
      ip: '203.0.113.5',
    } as never);
    expect(res.submission_id).toMatch(/^sub_/);
    expect(res.scores.income).toBe(50);
    expect(res.buckets.overall).toBe('moving');
    expect(res.roadmap_status).toBe('generating');
  });

  it('GET /diagnostic/:id returns roadmap_status=generating when no roadmap row exists yet', async () => {
    // Setting DIAGNOSTIC_AI_ENABLED=false would still write a placeholder
    // row, so for this test we simulate a slow-rolling AI provider by
    // skipping the persist (Prisma stub's aiRoadmap.upsert is a no-op).
    process.env.DIAGNOSTIC_AI_ENABLED = 'true';
    process.env.PERPLEXITY_API_KEY = '';
    const submitted = await controller.submit(
      { email: 'lead@example.com', answers: makeAnswers(2) },
      { headers: {}, ip: '127.0.0.1' } as never,
    );
    const result = await controller.get(submitted.submission_id);
    expect(result.submission.id).toBe(submitted.submission_id);
    expect(result.roadmap_status).toBe('generating');
    expect(result.roadmap).toBeNull();
  });
});
