/**
 * WearablePromptsRepository.markDismissed / markActedOn — F5 RLS-safe writes
 * (PR #399, PR #398 F3 pattern).
 *
 * Mocks PrismaService so this runs with NO DB / NO Supabase. It pins the F5
 * contract the R81 audit called out:
 *
 *   markDismissed / markActedOn are a SINGLE coach-scoped
 *   `updateMany ... WHERE { id, coachId, <state>:null }` that re-asserts
 *   ownership in the WHERE (RLS-safe TOCTOU close — the authorizing read and
 *   the write can't drift apart). A zero-row update is disambiguated with one
 *   coach-scoped read:
 *     - foreign / non-existent prompt  -> 404 (never 403, existence never leaks)
 *     - already-dismissed / acted row  -> idempotent return of the existing row
 */
import { NotFoundException } from '@nestjs/common';
import { WearablePromptsRepository } from '../wearable-prompts.repository';

const COACH_ID = '22222222-2222-2222-2222-222222222222';
const CLIENT_ID = '33333333-3333-3333-3333-333333333333';
const PROMPT_ID = '55555555-5555-5555-5555-555555555555';
const METRIC = 'HRV_MS';

function makePrisma() {
  return {
    communityWearablePrompt: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
  };
}

function row(over?: Partial<Record<string, unknown>>) {
  return {
    id: PROMPT_ID,
    workspaceId: '11111111-1111-1111-1111-111111111111',
    coachId: COACH_ID,
    clientId: CLIENT_ID,
    metricKey: METRIC,
    promptText: 'check in',
    generatedAt: new Date('2026-06-14T00:00:00.000Z'),
    dismissedAt: null,
    actedOnAt: null,
    sources: [],
    ...over,
  };
}

describe('WearablePromptsRepository.markDismissed / markActedOn (F5 RLS-safe)', () => {
  afterEach(() => jest.clearAllMocks());

  it('dismiss: single coach-scoped UPDATE ... WHERE { id, coachId, dismissedAt:null }', async () => {
    const prisma = makePrisma();
    prisma.communityWearablePrompt.updateMany.mockResolvedValue({ count: 1 });
    prisma.communityWearablePrompt.findFirst.mockResolvedValue(
      row({ dismissedAt: new Date('2026-06-14T00:01:00.000Z') }),
    );
    const repo = new WearablePromptsRepository(prisma as never);

    const at = new Date('2026-06-14T00:01:00.000Z');
    const out = await repo.markDismissed(PROMPT_ID, COACH_ID, at);

    expect(prisma.communityWearablePrompt.updateMany).toHaveBeenCalledTimes(1);
    const updateArg = prisma.communityWearablePrompt.updateMany.mock.calls[0]![0]!;
    expect(updateArg.where).toMatchObject({
      id: PROMPT_ID,
      coachId: COACH_ID,
      dismissedAt: null,
    });
    expect(updateArg.data).toEqual({ dismissedAt: at });
    expect(out.id).toBe(PROMPT_ID);
  });

  it('dismiss: foreign / non-existent prompt -> 404 (never 403, existence never leaks)', async () => {
    const prisma = makePrisma();
    prisma.communityWearablePrompt.updateMany.mockResolvedValue({ count: 0 });
    prisma.communityWearablePrompt.findFirst.mockResolvedValue(null); // not coach-owned
    const repo = new WearablePromptsRepository(prisma as never);
    await expect(
      repo.markDismissed(PROMPT_ID, COACH_ID, new Date()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('dismiss: already-dismissed prompt -> idempotent return of the existing row', async () => {
    const prisma = makePrisma();
    prisma.communityWearablePrompt.updateMany.mockResolvedValue({ count: 0 });
    const existing = row({ dismissedAt: new Date('2026-06-14T00:01:00.000Z') });
    prisma.communityWearablePrompt.findFirst.mockResolvedValue(existing);
    const repo = new WearablePromptsRepository(prisma as never);
    const out = await repo.markDismissed(PROMPT_ID, COACH_ID, new Date());
    expect(out).toBe(existing); // no re-stamp
    expect(prisma.communityWearablePrompt.updateMany).toHaveBeenCalledTimes(1);
  });

  it('act-on: single coach-scoped UPDATE ... WHERE { id, coachId, actedOnAt:null }', async () => {
    const prisma = makePrisma();
    prisma.communityWearablePrompt.updateMany.mockResolvedValue({ count: 1 });
    prisma.communityWearablePrompt.findFirst.mockResolvedValue(
      row({ actedOnAt: new Date('2026-06-14T00:02:00.000Z') }),
    );
    const repo = new WearablePromptsRepository(prisma as never);
    const at = new Date('2026-06-14T00:02:00.000Z');
    await repo.markActedOn(PROMPT_ID, COACH_ID, at);
    const updateArg = prisma.communityWearablePrompt.updateMany.mock.calls[0]![0]!;
    expect(updateArg.where).toMatchObject({
      id: PROMPT_ID,
      coachId: COACH_ID,
      actedOnAt: null,
    });
    expect(updateArg.data).toEqual({ actedOnAt: at });
  });

  it('act-on: foreign / non-existent prompt -> 404', async () => {
    const prisma = makePrisma();
    prisma.communityWearablePrompt.updateMany.mockResolvedValue({ count: 0 });
    prisma.communityWearablePrompt.findFirst.mockResolvedValue(null);
    const repo = new WearablePromptsRepository(prisma as never);
    await expect(
      repo.markActedOn(PROMPT_ID, COACH_ID, new Date()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
