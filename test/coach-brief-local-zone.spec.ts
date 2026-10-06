import {
  bucketDateLocal,
  CoachBriefService,
} from '../src/coach/brief/coach-brief.service';
import {
  asConfig,
  asPrismaService,
  makeMockConfig,
  makeMockPrisma,
} from './_fixtures/coach-brief-mocks';
import { grantAllEgress } from './ai-egress/ai-egress.fakes';

function setup() {
  const prisma = makeMockPrisma();
  prisma.coachBriefPreferences.findUnique.mockResolvedValue(null);
  const service = new CoachBriefService(
    asPrismaService(prisma), asConfig(makeMockConfig()), grantAllEgress(),
  );
  return { prisma, service };
}

describe('brief generation uses the same unsaved coach zone as the 08:00 push', () => {
  it('uses a device-supplied zone so the first Tokyo brief is today, not yesterday', async () => {
    const { prisma, service } = setup();
    prisma.user.findUnique.mockResolvedValue({
      notification_prefs: {
        timezone: 'Asia/Tokyo',
        timezone_updated_at: new Date('2026-10-06T20:00:00Z'),
      },
      coach_profile: { timezone: 'America/New_York' },
    });
    const timezone = await service.resolveCoachTimezone('coach-1');
    expect(timezone).toBe('Asia/Tokyo');
    expect(bucketDateLocal(new Date('2026-10-06T23:00:00Z'), timezone)).toBe('2026-10-07');
  });

  it('uses the coach profile before a schema-default notification zone', async () => {
    const { prisma, service } = setup();
    prisma.user.findUnique.mockResolvedValue({
      notification_prefs: { timezone: 'America/Los_Angeles', timezone_updated_at: null },
      coach_profile: { timezone: 'America/New_York' },
    });
    expect(await service.resolveCoachTimezone('coach-1')).toBe('America/New_York');
  });

  it('keeps an explicitly saved brief zone authoritative', async () => {
    const { prisma, service } = setup();
    prisma.coachBriefPreferences.findUnique.mockResolvedValue({ timezone: 'Europe/London' });
    expect(await service.resolveCoachTimezone('coach-1')).toBe('Europe/London');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('keeps the established Los Angeles fallback when no own zone is known', async () => {
    const { prisma, service } = setup();
    prisma.user.findUnique.mockResolvedValue({
      notification_prefs: null,
      coach_profile: null,
    });
    expect(await service.resolveCoachTimezone('coach-1')).toBe('America/Los_Angeles');
  });
});
