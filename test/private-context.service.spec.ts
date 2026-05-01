import { ForbiddenException } from '@nestjs/common';
import { PrivateContextService } from '../src/ai/gateway/private-context.service';

function buildPrisma(rows: Record<string, any>) {
  return {
    user: {
      findUnique: jest.fn(async ({ where }: any) => rows[where.id] ?? null),
    },
  } as any;
}

describe('PrivateContextService', () => {
  const subject = {
    id: 'client-1',
    name: 'Brad Smith',
    role: 'student',
    coach_id: 'coach-1',
    profile: {
      id: 'p-1',
      goal_type: 'fat_loss',
      activity_level: 'active',
      workout_experience: 'intermediate',
      current_weight_lbs: 192,
      target_weight_lbs: 178,
      height_cm: 183,
      preferred_snacks: ['cottage cheese'],
      equipment_access: ['barbell'],
    },
    coach_messages_as_client: [
      { id: 'm-1', body: 'Stay strict on dinner carbs.' },
    ],
  };

  it('returns sanitized context to the client themselves', async () => {
    const prisma = buildPrisma({ 'client-1': subject });
    const svc = new PrivateContextService(prisma);
    const ctx = await svc.loadClientContext(
      { id: 'client-1', role: 'student', coach_id: 'coach-1' },
      'client-1',
    );
    expect(ctx.systemPrompt).toContain('CLIENT_CONTEXT');
    expect(ctx.systemPrompt).toContain('fat_loss');
    // No PII identifiers should leak into the prompt.
    expect(ctx.systemPrompt).not.toContain('Smith');
    expect(ctx.systemPrompt).not.toContain('client-1'); // no UUIDs
    expect(ctx.provenance.length).toBeGreaterThanOrEqual(2);
    expect(ctx.provenance[0].source).toBe('user');
  });

  it('allows the assigned coach to load a client context', async () => {
    const prisma = buildPrisma({ 'client-1': subject });
    const svc = new PrivateContextService(prisma);
    const ctx = await svc.loadClientContext(
      { id: 'coach-1', role: 'coach' },
      'client-1',
    );
    expect(ctx.systemPrompt).toContain('CLIENT_CONTEXT');
  });

  it('refuses cross-tenant access from a different coach', async () => {
    const prisma = buildPrisma({ 'client-1': subject });
    const svc = new PrivateContextService(prisma);
    await expect(
      svc.loadClientContext({ id: 'coach-2', role: 'coach' }, 'client-1'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('lets owners read any client context', async () => {
    const prisma = buildPrisma({ 'client-1': subject });
    const svc = new PrivateContextService(prisma);
    const ctx = await svc.loadClientContext(
      { id: 'owner-1', role: 'owner' },
      'client-1',
    );
    expect(ctx.systemPrompt).toContain('CLIENT_CONTEXT');
  });

  it('refuses access to a missing subject', async () => {
    const prisma = buildPrisma({});
    const svc = new PrivateContextService(prisma);
    await expect(
      svc.loadClientContext({ id: 'owner-1', role: 'owner' }, 'nope'),
    ).rejects.toThrow(ForbiddenException);
  });
});
