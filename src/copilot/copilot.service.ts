import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AiActionDraft } from '@prisma/client';
import { AiConsentRequiredException } from '../ai-egress/ai-consent-required.exception';
import { AiEgressService } from '../ai-egress/ai-egress.service';
import { CLIENT_PATH_CHANGE, PATH_CHANGE_PENDING_MS, pathChangeLapsed } from '../ai/gateway/materialisers/client-path-change.materialiser';
import { PrismaService } from '../prisma.service';
import { assertRomanClient } from '../roman/roman-requires-coach';

/** Sent states the client sees as status lines; `suggested` (not sent yet) never reaches the coach or this list. */
const SENT = ['pending', 'approved', 'rejected', 'expired'];
export const COPILOT_RECENT = 3;

export interface CopilotSuggestionView {
  id: string;
  status: string;
  change: unknown;
  reason: string | null;
  note: string | null;
  sent_at: Date;
  decided_at: Date | null;
}

const view = (d: AiActionDraft): CopilotSuggestionView => ({
  id: d.id,
  // #CP-LAPSE: a sent suggestion the coach did not decide within PATH_CHANGE_PENDING_MS reads as expired.
  status: pathChangeLapsed(d) ? 'expired' : d.status,
  change: d.payload,
  reason: d.rationale,
  note: d.decision_note,
  sent_at: d.created_at,
  decided_at: d.decided_at,
});

/**
 * COPILOT-BE: the client's half of a Copilot plan change. Roman's turn writes the change as an AiActionDraft with status
 * `suggested`, no tenant, the client as requester and subject, so no coach can read it (RLS and every queue key on the
 * tenant). Send is the one step that hands it to the client's current coach. Not counted in the 5 changes a day
 * (owner #CP-COUNT op 1: `coach_approved_change` has no count in roman-usage.ts).
 */
@Injectable()
export class CopilotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly egress: AiEgressService,
  ) {}

  private mine(clientId: string) {
    return { capability: CLIENT_PATH_CHANGE, requester_id: clientId, subject_user_id: clientId };
  }

  /** Newest first, the last three sent, and how many the client has sent in all. */
  async recent(clientId: string) {
    const where = { ...this.mine(clientId), status: { in: SENT } };
    const [rows, total] = await Promise.all([
      this.prisma.aiActionDraft.findMany({ where, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: COPILOT_RECENT }),
      this.prisma.aiActionDraft.count({ where }),
    ]);
    return { suggestions: rows.map(view), suggestions_total: total };
  }

  /** Send to the coach: `suggested` -> `pending`, stamped with the client's coach now. A repeat Send answers the same row. */
  async send(client: { id: string; role: string; coach_id: string | null }, id: string): Promise<CopilotSuggestionView> {
    assertRomanClient(client);
    if (!(await this.egress.consentedClients([client.id])).has(client.id)) throw new AiConsentRequiredException('client');
    const now = new Date();
    const mine = { id, ...this.mine(client.id) };
    await this.prisma.aiActionDraft.updateMany({
      where: { ...mine, status: 'suggested', OR: [{ expires_at: null }, { expires_at: { gt: now } }] },
      // created_at becomes the moment it was sent: the coach's queue reads oldest first from it.
      data: { status: 'pending', tenant_coach_id: client.coach_id, created_at: now, expires_at: new Date(now.getTime() + PATH_CHANGE_PENDING_MS) },
    });
    const row = await this.prisma.aiActionDraft.findFirst({ where: mine });
    if (!row) throw new NotFoundException('Suggestion not found');
    if (row.status === 'suggested') {
      throw new ConflictException({ code: 'COPILOT_SUGGESTION_EXPIRED', message: 'This suggestion is no longer available. Ask Roman again.' });
    }
    return view(row);
  }
}
