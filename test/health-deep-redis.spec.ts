import Redis from 'ioredis';
import { HealthDeepController } from '../src/observability/health-deep.controller';
import type { PrismaService } from '../src/prisma.service';

const mockClient = { connect: jest.fn(), ping: jest.fn(), disconnect: jest.fn() };
jest.mock('ioredis', () => jest.fn(() => mockClient));
describe('deep health throwaway Redis probe', () => {
  const controller = new HealthDeepController({} as PrismaService);
  let errors: string[];
  const probe = () => controller['checkRedis']('redis://probe.invalid', errors);
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    errors = [];
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.ping.mockResolvedValue('PONG');
  });
  afterEach(() => {
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
  it('waits for readiness, then PINGs, with no background retries', async () => {
    let ready!: () => void;
    mockClient.connect.mockReturnValue(new Promise<void>((resolve) => (ready = resolve)));
    const result = probe();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockClient.ping).not.toHaveBeenCalled();
    ready();
    expect(await result).toBe('up');
    const [connected] = mockClient.connect.mock.invocationCallOrder;
    expect(connected).toBeLessThan(mockClient.ping.mock.invocationCallOrder[0]);
    expect(Redis).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ retryStrategy: null }),
    );
    expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });
  it.each(['connect', 'ping'] as const)('disconnects on %s failure', async (stage) => {
    mockClient[stage].mockRejectedValue(new Error(`${stage} failed`));
    expect(await probe()).toBe('down');
    expect(errors).toEqual(['redis: unavailable']);
    expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
    if (stage === 'connect') expect(mockClient.ping).not.toHaveBeenCalled();
  });
  it.each(['connect', 'ping'] as const)('bounds %s by 2000ms total', async (stage) => {
    let ready!: () => void;
    mockClient.connect.mockReturnValue(new Promise<void>((resolve) => (ready = resolve)));
    if (stage === 'ping') setTimeout(() => ready(), 1500);
    mockClient.ping.mockReturnValue(new Promise<string>(() => {}));
    const result = probe();
    let settled = false;
    void result.then(() => (settled = true));
    await jest.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await result).toBe('down');
    expect(errors).toEqual(['redis: unavailable']);
    expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
    ready();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockClient.ping).toHaveBeenCalledTimes(stage === 'connect' ? 0 : 1);
  });
});
