import { PtmService } from '../src/ptm/ptm.service';

describe('PtmService', () => {
  function buildPrisma() {
    return {
      clientSignal: {
        create: jest.fn(async ({ data }: any) => ({ id: 's-1', ...data })),
      },
      ptmPrediction: {
        findFirst: jest.fn(async () => null),
        findMany: jest.fn(async () => []),
      },
    } as any;
  }

  describe('emit (sync wrapper)', () => {
    it('returns void synchronously — caller never awaits a promise', () => {
      const prisma = buildPrisma();
      const svc = new PtmService(prisma);
      const result = svc.emit('user-1', 'message_sent', 42);
      expect(result).toBeUndefined();
    });

    it('schedules a recordSignal write that lands on the next tick', async () => {
      const prisma = buildPrisma();
      const svc = new PtmService(prisma);
      svc.emit('user-1', 'workout_logged', 1234, { exercise_count: 4 });
      // Drain the microtask queue so the void-promise inside emit resolves.
      await new Promise((r) => setImmediate(r));
      expect(prisma.clientSignal.create).toHaveBeenCalledTimes(1);
      const data = prisma.clientSignal.create.mock.calls[0][0].data;
      expect(data.user_id).toBe('user-1');
      expect(data.signal_type).toBe('workout_logged');
      expect(data.value).toBe(1234);
      expect(data.metadata).toEqual({ exercise_count: 4 });
    });
  });

  describe('recordSignal', () => {
    it('writes a ClientSignal row with all populated fields', async () => {
      const prisma = buildPrisma();
      const svc = new PtmService(prisma);
      const recordedAt = new Date('2026-04-24T10:00:00.000Z');
      await svc.recordSignal({
        userId: 'user-1',
        signalType: 'meal_logged',
        value: 600,
        metadata: { meal_type: 'breakfast' },
        recordedAt,
      });
      expect(prisma.clientSignal.create).toHaveBeenCalledTimes(1);
      const data = prisma.clientSignal.create.mock.calls[0][0].data;
      expect(data.user_id).toBe('user-1');
      expect(data.signal_type).toBe('meal_logged');
      expect(data.value).toBe(600);
      expect(data.metadata).toEqual({ meal_type: 'breakfast' });
      expect(data.recorded_at).toBe(recordedAt);
    });

    it('defaults value to 1 and omits recorded_at when not supplied', async () => {
      const prisma = buildPrisma();
      const svc = new PtmService(prisma);
      await svc.recordSignal({ userId: 'user-1', signalType: 'app_open' });
      const data = prisma.clientSignal.create.mock.calls[0][0].data;
      expect(data.value).toBe(1);
      expect(data.recorded_at).toBeUndefined();
    });

    // PTM is on the user-facing hot path. A failure to write the signal must
    // never bubble — the upstream check-in / weight / message handler has
    // already succeeded by the time emit fires.
    it('swallows DB errors instead of throwing', async () => {
      const prisma: any = buildPrisma();
      prisma.clientSignal.create = jest
        .fn()
        .mockRejectedValue(new Error('connection refused'));
      const svc = new PtmService(prisma);
      await expect(
        svc.recordSignal({ userId: 'user-1', signalType: 'message_sent' }),
      ).resolves.toBeUndefined();
    });

    it('logs an error line when the write fails (no PII)', async () => {
      const prisma: any = buildPrisma();
      prisma.clientSignal.create = jest
        .fn()
        .mockRejectedValue(new Error('table locked'));
      const svc = new PtmService(prisma);
      const errorSpy = jest
        .spyOn((svc as any).logger, 'error')
        .mockImplementation(() => undefined);
      await svc.recordSignal({
        userId: 'user-secret',
        signalType: 'workout_logged',
      });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const line = errorSpy.mock.calls[0][0] as string;
      expect(line).toContain('user-secret');
      expect(line).toContain('workout_logged');
      expect(line).toContain('table locked');
    });
  });

  describe('reads', () => {
    it('getLatestPrediction calls findFirst sorted by computed_at desc', async () => {
      const prisma = buildPrisma();
      const svc = new PtmService(prisma);
      await svc.getLatestPrediction('user-1');
      expect(prisma.ptmPrediction.findFirst).toHaveBeenCalledTimes(1);
      const args = prisma.ptmPrediction.findFirst.mock.calls[0][0];
      expect(args.where).toEqual({ user_id: 'user-1' });
      expect(args.orderBy).toEqual({ computed_at: 'desc' });
    });

    it('listPredictionHistory clamps limit to [1, 365]', async () => {
      const prisma = buildPrisma();
      const svc = new PtmService(prisma);
      await svc.listPredictionHistory('user-1', 9999);
      expect(prisma.ptmPrediction.findMany.mock.calls[0][0].take).toBe(365);
      await svc.listPredictionHistory('user-1', 0);
      expect(prisma.ptmPrediction.findMany.mock.calls[1][0].take).toBe(1);
    });
  });
});
