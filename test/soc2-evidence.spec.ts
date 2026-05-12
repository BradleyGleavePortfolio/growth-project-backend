import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../src/auth/roles.guard';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { Soc2EvidenceController } from '../src/admin/soc2/soc2-evidence.controller';
import { Soc2EvidenceService } from '../src/admin/soc2/soc2-evidence.service';
import type { EvidenceSnapshot } from '../src/admin/soc2/soc2-evidence.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPrisma(auditRows: object[] = []) {
  return {
    auditLog: {
      findMany: jest.fn(async () => auditRows),
    },
  };
}

function buildService(auditRows: object[] = []) {
  return new Soc2EvidenceService(buildPrisma(auditRows) as any);
}

// Build a minimal ExecutionContext mock for RolesGuard tests.
function buildContext(role: string | undefined) {
  const reflector = new Reflector();
  // Simulate the guard reading @Roles('owner') metadata from the handler.
  jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['owner']);
  const guard = new RolesGuard(reflector);
  const context = {
    getHandler: jest.fn(() => ({})),
    getClass: jest.fn(() => ({})),
    switchToHttp: jest.fn(() => ({
      getRequest: jest.fn(() => ({
        user: role ? { role } : undefined,
      })),
    })),
  } as any;
  return { guard, context };
}

// ---------------------------------------------------------------------------
// Role-guard tests
// ---------------------------------------------------------------------------

describe('Soc2EvidenceController — role guard', () => {
  it('allows owner role through', () => {
    const { guard, context } = buildContext('owner');
    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects coach role with ForbiddenException', () => {
    const { guard, context } = buildContext('coach');
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('rejects student role with ForbiddenException', () => {
    const { guard, context } = buildContext('student');
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('rejects unauthenticated request with ForbiddenException', () => {
    const { guard, context } = buildContext(undefined);
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('controller method is decorated with @Roles("owner")', () => {
    // Verify the decorator metadata is present on the handler so that
    // RolesGuard actually reads 'owner' at runtime. This guards against
    // a future refactor accidentally removing the decorator.
    const controller = new Soc2EvidenceController(
      buildService() as Soc2EvidenceService,
    );
    const metadata = Reflect.getMetadata(
      ROLES_KEY,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      Soc2EvidenceController.prototype.evidenceSnapshot,
    );
    // Metadata may be on the method or on the class — check both.
    const classMetadata = Reflect.getMetadata(ROLES_KEY, Soc2EvidenceController);
    expect(metadata ?? classMetadata).toContain('owner');
    // Keep the controller reference to avoid "unused variable" lint error.
    expect(controller).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Snapshot shape tests
// ---------------------------------------------------------------------------

describe('Soc2EvidenceService.buildSnapshot — shape and PII safety', () => {
  const AUDIT_ROW = {
    id: 'audit-1',
    action: 'user.role_changed',
    actor_role: 'owner',
    actor_email_snapshot: 'bradley@example.com',
    target_user_id: 'u-target',
    target_type: 'user',
    created_at: new Date('2025-01-15T10:00:00Z'),
  };

  it('returns all required top-level keys', async () => {
    const svc = buildService([AUDIT_ROW]);
    const snapshot: EvidenceSnapshot = await svc.buildSnapshot();

    const requiredKeys: (keyof EvidenceSnapshot)[] = [
      'snapshotAt',
      'flyConfig',
      'schemaHash',
      'roleDecoratedRoutes',
      'auditLogSample',
      'deploymentHistory',
    ];
    for (const key of requiredKeys) {
      expect(snapshot).toHaveProperty(key);
    }
  });

  it('snapshotAt is a valid ISO-8601 timestamp', async () => {
    const svc = buildService();
    const { snapshotAt } = await svc.buildSnapshot();
    expect(new Date(snapshotAt).toISOString()).toBe(snapshotAt);
  });

  it('flyConfig contains expected sub-keys', async () => {
    const svc = buildService();
    const { flyConfig } = await svc.buildSnapshot();
    expect(flyConfig).toHaveProperty('appName');
    expect(flyConfig).toHaveProperty('primaryRegion');
    expect(flyConfig).toHaveProperty('nodeEnv');
    expect(flyConfig).toHaveProperty('corsOrigins');
    expect(flyConfig).toHaveProperty('featureFlags');
  });

  it('schemaHash is a string (or "unavailable" in test env)', async () => {
    const svc = buildService();
    const { schemaHash } = await svc.buildSnapshot();
    expect(typeof schemaHash).toBe('string');
    expect(schemaHash.length).toBeGreaterThan(0);
  });

  it('roleDecoratedRoutes is a non-empty array with correct shape', async () => {
    const svc = buildService();
    const { roleDecoratedRoutes } = await svc.buildSnapshot();
    expect(Array.isArray(roleDecoratedRoutes)).toBe(true);
    expect(roleDecoratedRoutes.length).toBeGreaterThan(0);

    for (const route of roleDecoratedRoutes) {
      expect(typeof route.controller).toBe('string');
      expect(typeof route.method).toBe('string');
      expect(typeof route.path).toBe('string');
      expect(Array.isArray(route.roles)).toBe(true);
      expect(route.roles.length).toBeGreaterThan(0);
    }
  });

  it('evidence-snapshot route appears in roleDecoratedRoutes with owner role', async () => {
    const svc = buildService();
    const { roleDecoratedRoutes } = await svc.buildSnapshot();
    const snapshotRoute = roleDecoratedRoutes.find(
      (r) => r.path === '/admin/soc2/evidence-snapshot',
    );
    expect(snapshotRoute).toBeDefined();
    expect(snapshotRoute?.roles).toContain('owner');
  });

  it('deploymentHistory is an array', async () => {
    const svc = buildService();
    const { deploymentHistory } = await svc.buildSnapshot();
    expect(Array.isArray(deploymentHistory)).toBe(true);
  });

  // ---
  // PII safety: audit log entries must not contain raw email addresses,
  // IP addresses, or health data.
  // ---

  it('auditLogSample redacts actor email — raw email is not present', async () => {
    const svc = buildService([AUDIT_ROW]);
    const { auditLogSample } = await svc.buildSnapshot();
    expect(auditLogSample).toHaveLength(1);
    const entry = auditLogSample[0];

    // The raw email must NOT appear.
    expect(JSON.stringify(entry)).not.toContain('bradley@example.com');

    // The redacted form MUST appear and match the expected pattern.
    // "bradley@example.com" → "br...@example.com"
    expect(entry.actorEmailRedacted).toBe('br...@example.com');
  });

  it('auditLogSample entries do not contain IP address field', async () => {
    const rowWithIp = { ...AUDIT_ROW, ip: '1.2.3.4' };
    const svc = buildService([rowWithIp]);
    const { auditLogSample } = await svc.buildSnapshot();
    for (const entry of auditLogSample) {
      expect(entry).not.toHaveProperty('ip');
      expect(JSON.stringify(entry)).not.toContain('1.2.3.4');
    }
  });

  it('auditLogSample entries do not contain user_agent field', async () => {
    const rowWithUa = { ...AUDIT_ROW, user_agent: 'Mozilla/5.0 (test)' };
    const svc = buildService([rowWithUa]);
    const { auditLogSample } = await svc.buildSnapshot();
    for (const entry of auditLogSample) {
      expect(entry).not.toHaveProperty('userAgent');
      expect(entry).not.toHaveProperty('user_agent');
    }
  });

  it('auditLogSample entries do not contain metadata field', async () => {
    const rowWithMeta = {
      ...AUDIT_ROW,
      metadata: { testosterone_ng_dl: 450 }, // health data — must NOT leak
    };
    const svc = buildService([rowWithMeta]);
    const { auditLogSample } = await svc.buildSnapshot();
    for (const entry of auditLogSample) {
      expect(entry).not.toHaveProperty('metadata');
      expect(JSON.stringify(entry)).not.toContain('testosterone');
    }
  });

  it('handles empty audit log gracefully', async () => {
    const svc = buildService([]);
    const { auditLogSample } = await svc.buildSnapshot();
    expect(auditLogSample).toEqual([]);
  });

  it('handles Prisma error gracefully — returns empty array, does not throw', async () => {
    const brokenPrisma = {
      auditLog: {
        findMany: jest.fn().mockRejectedValue(new Error('DB connection lost')),
      },
    };
    const svc = new Soc2EvidenceService(brokenPrisma as any);
    const { auditLogSample } = await svc.buildSnapshot();
    expect(auditLogSample).toEqual([]);
  });
});
