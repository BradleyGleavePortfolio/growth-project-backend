import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { broadcastError } from './broadcast-errors';
import { BroadcastScopeService } from './broadcast-scope.service';
import { normalizeTag } from './segment';

/**
 * Coach-private client tags (a segment input). Rows live under the head
 * coach's tenant id; a sub-coach may tag only clients assigned to them.
 * Tags are never returned by any client-facing route.
 */
@Injectable()
export class ClientTagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: BroadcastScopeService,
    private readonly audit: AuditService,
  ) {}

  async listForClient(actorId: string, clientId: string) {
    const scope = await this.scopes.resolve(actorId);
    if (!scope.clientIds.includes(clientId)) throw broadcastError('client_tags.client_not_found');
    const rows = await this.prisma.coachClientTag.findMany({
      where: { coach_id: scope.tenantId, client_id: clientId },
      orderBy: { tag: 'asc' },
      select: { tag: true },
    });
    return { client_id: clientId, tags: rows.map((r) => r.tag) };
  }

  async replace(actorId: string, clientId: string, raw: unknown[]) {
    const scope = await this.scopes.resolve(actorId);
    if (!scope.clientIds.includes(clientId)) throw broadcastError('client_tags.client_not_found');
    if (!Array.isArray(raw) || raw.length > 20) throw broadcastError('client_tags.invalid');
    const tags = new Set<string>();
    for (const t of raw) {
      const n = normalizeTag(t);
      if (!n) throw broadcastError('client_tags.invalid');
      tags.add(n);
    }
    const wanted = [...tags];
    await this.prisma.$transaction([
      this.prisma.coachClientTag.deleteMany({
        where: { coach_id: scope.tenantId, client_id: clientId, tag: { notIn: wanted } },
      }),
      this.prisma.coachClientTag.createMany({
        data: wanted.map((tag) => ({ coach_id: scope.tenantId, client_id: clientId, tag })),
        skipDuplicates: true,
      }),
    ]);
    void this.audit.write({
      action: 'client_tags.replaced',
      actorId,
      actorRole: 'coach',
      targetUserId: clientId,
      tenantCoachId: scope.tenantId,
      metadata: { count: wanted.length },
    });
    return { client_id: clientId, tags: wanted.sort() };
  }

  async listAll(actorId: string) {
    const scope = await this.scopes.resolve(actorId);
    if (scope.clientIds.length === 0) return { tags: [] };
    const groups = await this.prisma.coachClientTag.groupBy({
      by: ['tag'],
      where: { coach_id: scope.tenantId, client_id: { in: scope.clientIds } },
      _count: { _all: true },
      orderBy: { tag: 'asc' },
    });
    return { tags: groups.map((g) => ({ tag: g.tag, client_count: g._count._all })) };
  }
}
