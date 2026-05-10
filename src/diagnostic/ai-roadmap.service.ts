import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import OpenAI from 'openai';
import { PrismaService } from '../prisma.service';
import {
  DiagnosticBuckets,
  DiagnosticScores,
  RoadmapPayload,
  SubmitDiagnosticDto,
} from './diagnostic.dto';
import { loadCatalog } from './question-catalog';

/**
 * AiRoadmapService — single responsibility: take a scored submission, build
 * the prompt verbatim from the pinned template, call Perplexity sonar-pro,
 * and persist the result onto AiRoadmap.
 *
 * Doctrine:
 *   * The prompt is the product. Voice rules (no emoji, no hype, numbers
 *     over adjectives, 300-400 words) are pinned in
 *     test/ai-prompt-doctrine.spec.ts. Touching ROADMAP_SYSTEM_PROMPT
 *     without updating that pin must fail CI.
 *   * Failures never throw — the diagnostic submit endpoint already
 *     returned the submission_id. We persist a row with status='failed' so
 *     the GET endpoint can serve a deterministic retry path.
 *   * DIAGNOSTIC_AI_ENABLED=false short-circuits the call and stores a
 *     placeholder payload tagged status='ready'. Operators use this in
 *     environments without a Perplexity key (CI, preview deploys).
 */

// PINNED prompt template. The doctrine spec asserts the canonical opening
// line — bumping voice rules requires bumping the pin in lockstep.
export const ROADMAP_SYSTEM_PROMPT = `You are the diagnostic analyst for The Growth Project. You read a person's 40-point self-assessment across three dimensions — Income Architecture, Body Protocol, and Calendar & Lifestyle Architecture — and return a written roadmap.

Voice rules (non-negotiable):
- No emoji. No exclamation marks. No em-dashes.
- No corporate wellness vocabulary. No motivational hype.
- Numbers over adjectives. Cite the section scores you were given.
- Direct address ("you"), present tense, second person.
- 300 to 400 words total. Do not exceed 400.

Output sections, in order, separated by a blank line:
1. Overall assessment — one paragraph reading the three section scores together.
2. Top strength — one paragraph naming the highest-scoring section and what it enables.
3. Biggest gap — one paragraph naming the lowest-scoring section and one specific recommendation.
4. The next 90 days — one paragraph describing what to focus on, with a concrete weekly cadence.

Do not use Markdown headings. Do not number the paragraphs in the output. Return only the four paragraphs as plain text.`;

export const ROADMAP_PROMPT_VERSION = 'v1';

interface RoadmapInput {
  scores: DiagnosticScores;
  buckets: DiagnosticBuckets;
  weakest_questions_per_section: Array<{ section: string; question_id: number; text: string; answer: number }>;
  current_date_iso: string;
}

@Injectable()
export class AiRoadmapService {
  private readonly logger = new Logger(AiRoadmapService.name);
  private readonly client: OpenAI;

  constructor(private readonly prisma: PrismaService) {
    // Same Perplexity-OpenAI compatibility shim used by AiService. Kept
    // local so the diagnostic module does not depend on AiService's
    // user-context plumbing (which is for authed clients only).
    this.client = new OpenAI({
      apiKey: process.env.PERPLEXITY_API_KEY || '',
      baseURL: 'https://api.perplexity.ai',
    });
  }

  buildUserPrompt(body: SubmitDiagnosticDto, scores: DiagnosticScores, buckets: DiagnosticBuckets): string {
    const catalog = loadCatalog();
    const byId = new Map<number, { section: string; text: string }>();
    for (const q of catalog.questions) byId.set(q.id, { section: q.section, text: q.text });

    // Pull the three lowest-scoring questions per section. These give the
    // model concrete language to reference rather than abstract scores.
    const bySection: Record<string, Array<{ question_id: number; text: string; answer: number }>> = {
      income: [],
      body: [],
      lifestyle: [],
    };
    for (const a of body.answers) {
      const meta = byId.get(a.question_id);
      if (!meta) continue;
      bySection[meta.section].push({ question_id: a.question_id, text: meta.text, answer: a.answer });
    }
    const weakest: RoadmapInput['weakest_questions_per_section'] = [];
    for (const section of ['income', 'body', 'lifestyle'] as const) {
      const sorted = [...bySection[section]].sort((a, b) => a.answer - b.answer).slice(0, 3);
      for (const q of sorted) weakest.push({ section, ...q });
    }

    const today = new Date().toISOString().slice(0, 10);
    const lines: string[] = [];
    lines.push(`Today: ${today}.`);
    lines.push('');
    lines.push('Section scores (0-100% of max):');
    lines.push(`  Income Architecture: ${scores.income}% — bucket=${buckets.income} (raw ${scores.income_raw}/75)`);
    lines.push(`  Body Protocol: ${scores.body}% — bucket=${buckets.body} (raw ${scores.body_raw}/60)`);
    lines.push(`  Calendar & Lifestyle: ${scores.lifestyle}% — bucket=${buckets.lifestyle} (raw ${scores.lifestyle_raw}/65)`);
    lines.push('');
    lines.push(`Overall raw score: ${scores.overall_raw}/200 — bucket=${buckets.overall}.`);
    lines.push(`Overall headline (do not quote verbatim): "${buckets.overall_headline}"`);
    lines.push('');
    lines.push('Lowest-scoring questions per section (for reference, do not list them all back):');
    for (const w of weakest) {
      lines.push(`  [${w.section}] Q${w.question_id} (answer=${w.answer}): ${w.text}`);
    }
    return lines.join('\n');
  }

  async generateAndPersist(
    submissionId: string,
    scores: DiagnosticScores,
    buckets: DiagnosticBuckets,
    body: SubmitDiagnosticDto,
  ): Promise<void> {
    const enabled = (process.env.DIAGNOSTIC_AI_ENABLED ?? 'true').toLowerCase() !== 'false';
    if (!enabled) {
      await this.persistPlaceholder(submissionId, scores, buckets);
      return;
    }
    if (!process.env.PERPLEXITY_API_KEY || process.env.PERPLEXITY_API_KEY.trim() === '') {
      await this.persistFailure(submissionId, 'PERPLEXITY_API_KEY not configured');
      return;
    }

    const userPrompt = this.buildUserPrompt(body, scores, buckets);
    try {
      const response = await this.client.chat.completions.create({
        model: 'sonar-pro',
        messages: [
          { role: 'system', content: ROADMAP_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.4,
        max_tokens: 700,
      });
      const text = response.choices[0]?.message?.content?.trim();
      if (!text) {
        await this.persistFailure(submissionId, 'empty_response_from_provider');
        return;
      }
      const parsed = this.parseRoadmap(text);
      const tokensUsed = response.usage?.total_tokens ?? null;
      await this.persistRoadmap(submissionId, parsed, tokensUsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Perplexity diagnostic-roadmap call failed: ${msg}`);
      await this.persistFailure(submissionId, msg);
    }
  }

  /**
   * Splits the four-paragraph response into the structured payload. We
   * accept loose formatting (extra blank lines, optional leading numbers
   * the model occasionally adds) because reformatting the prose costs
   * more than just being permissive on parse.
   */
  parseRoadmap(text: string): RoadmapPayload {
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((p) => p.replace(/^\s*\d+\.\s*/, '').trim())
      .filter((p) => p.length > 0);

    const summary = paragraphs[0] ?? text;
    const top_strength = paragraphs[1] ?? '';
    const biggest_gap = paragraphs[2] ?? '';
    const ninety_day_focus = paragraphs[3] ?? '';
    return { summary, top_strength, biggest_gap, ninety_day_focus, raw_text: text };
  }

  private async persistRoadmap(
    submissionId: string,
    payload: RoadmapPayload,
    tokensUsed: number | null,
  ): Promise<void> {
    await this.prisma.aiRoadmap.upsert({
      where: { submission_id: submissionId },
      update: {
        status: 'ready',
        payload: payload as unknown as Prisma.InputJsonValue,
        tokens_used: tokensUsed,
        error_message: null,
        prompt_version: ROADMAP_PROMPT_VERSION,
        generated_at: new Date(),
      },
      create: {
        submission_id: submissionId,
        status: 'ready',
        payload: payload as unknown as Prisma.InputJsonValue,
        tokens_used: tokensUsed,
        prompt_version: ROADMAP_PROMPT_VERSION,
      },
    });
  }

  private async persistPlaceholder(
    submissionId: string,
    scores: DiagnosticScores,
    buckets: DiagnosticBuckets,
  ): Promise<void> {
    const placeholder: RoadmapPayload = {
      summary: `Diagnostic submitted. Overall bucket: ${buckets.overall}. AI generation is disabled in this environment.`,
      top_strength: '',
      biggest_gap: '',
      ninety_day_focus: '',
      raw_text: `DIAGNOSTIC_AI_ENABLED=false; scores=${JSON.stringify(scores)}`,
    };
    await this.prisma.aiRoadmap.upsert({
      where: { submission_id: submissionId },
      update: {
        status: 'ready',
        payload: placeholder as unknown as Prisma.InputJsonValue,
        prompt_version: ROADMAP_PROMPT_VERSION,
      },
      create: {
        submission_id: submissionId,
        status: 'ready',
        payload: placeholder as unknown as Prisma.InputJsonValue,
        prompt_version: ROADMAP_PROMPT_VERSION,
      },
    });
  }

  private async persistFailure(submissionId: string, message: string): Promise<void> {
    await this.prisma.aiRoadmap.upsert({
      where: { submission_id: submissionId },
      update: {
        status: 'failed',
        payload: Prisma.JsonNull,
        error_message: message.slice(0, 500),
        prompt_version: ROADMAP_PROMPT_VERSION,
      },
      create: {
        submission_id: submissionId,
        status: 'failed',
        error_message: message.slice(0, 500),
        prompt_version: ROADMAP_PROMPT_VERSION,
      },
    });
  }
}
