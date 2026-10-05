import type { PrismaClient } from '@prisma/client';
import {
  DEFAULT_WELCOME_TEMPLATE,
  validateWelcomeTemplate,
  WELCOME_TEMPLATE_VARIABLES,
} from './welcome-template';

// Shared by the owner endpoint (PUT /api/admin/coaches/:coachId/welcome-message)
// and the operator script (scripts/set-coach-welcome-message.ts) so both paths
// apply the same validation and the same enabled_at rule.

export type WelcomeSettingsDb = Pick<PrismaClient, 'user' | 'coachWelcomeMessageSetting'>;

export interface WelcomeSettingsView {
  coach_id: string;
  enabled: boolean;
  /** The coach's own template, or null when the generic default applies. */
  template: string | null;
  effective_template: string;
  default_template: string;
  placeholders: readonly string[];
  enabled_at: string | null;
  updated_at: string | null;
}

export interface WelcomeSettingsUpdate {
  enabled?: boolean;
  /** string = set; null = clear back to the default; undefined = unchanged. */
  template?: string | null;
}

export class WelcomeSettingsError extends Error {
  constructor(
    readonly code: 'coach_not_found' | 'invalid_template' | 'nothing_to_update',
    readonly detail?: string,
  ) {
    super(code);
    this.name = 'WelcomeSettingsError';
  }
}

const COACH_ROLES = ['coach', 'owner'] as const;

async function assertCoach(db: WelcomeSettingsDb, coachId: string): Promise<void> {
  const coach = await db.user.findFirst({
    where: { id: coachId, role: { in: [...COACH_ROLES] }, deleted_at: null },
    select: { id: true },
  });
  if (!coach) throw new WelcomeSettingsError('coach_not_found');
}

function view(
  coachId: string,
  row: {
    enabled: boolean;
    template: string | null;
    enabled_at: Date | null;
    updated_at: Date;
  } | null,
): WelcomeSettingsView {
  return {
    coach_id: coachId,
    enabled: row?.enabled ?? false,
    template: row?.template ?? null,
    effective_template: row?.template ?? DEFAULT_WELCOME_TEMPLATE,
    default_template: DEFAULT_WELCOME_TEMPLATE,
    placeholders: WELCOME_TEMPLATE_VARIABLES,
    enabled_at: row?.enabled_at?.toISOString() ?? null,
    updated_at: row?.updated_at?.toISOString() ?? null,
  };
}

export async function getWelcomeSettings(
  db: WelcomeSettingsDb,
  coachId: string,
): Promise<WelcomeSettingsView> {
  await assertCoach(db, coachId);
  const row = await db.coachWelcomeMessageSetting.findUnique({ where: { coach_id: coachId } });
  return view(coachId, row);
}

export async function updateWelcomeSettings(
  db: WelcomeSettingsDb,
  coachId: string,
  update: WelcomeSettingsUpdate,
  actorId: string,
  now: Date = new Date(),
): Promise<WelcomeSettingsView> {
  if (update.enabled === undefined && update.template === undefined) {
    throw new WelcomeSettingsError('nothing_to_update');
  }
  await assertCoach(db, coachId);
  let template: string | null | undefined = update.template;
  if (typeof update.template === 'string') {
    const checked = validateWelcomeTemplate(update.template);
    if (!checked.ok) {
      throw new WelcomeSettingsError(
        'invalid_template',
        checked.detail ? `${checked.code}:${checked.detail}` : checked.code,
      );
    }
    template = checked.template;
  }
  const existing = await db.coachWelcomeMessageSetting.findUnique({
    where: { coach_id: coachId },
    select: { enabled: true },
  });
  const turningOn = update.enabled === true && !existing?.enabled;
  const row = await db.coachWelcomeMessageSetting.upsert({
    where: { coach_id: coachId },
    create: {
      coach_id: coachId,
      enabled: update.enabled ?? false,
      template: template ?? null,
      enabled_at: update.enabled ? now : null,
      updated_by: actorId,
    },
    update: {
      ...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
      ...(template !== undefined ? { template } : {}),
      ...(turningOn ? { enabled_at: now } : {}),
      updated_by: actorId,
    },
  });
  return view(coachId, row);
}
