import {
  ProviderHttpClient,
  ProviderHttpError,
} from './provider-http-client';
import { BACKOFF_DEFAULTS } from '../wearables.constants';

/** Build a minimal Response-like object the client treats as a fetch Response. */
function makeResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
  } as unknown as Response;
}

describe('ProviderHttpClient', () => {
  let fetchFn: jest.Mock;
  let sleeps: number[];
  let client: ProviderHttpClient;

  beforeEach(() => {
    fetchFn = jest.fn();
    sleeps = [];
    client = new ProviderHttpClient({
      fetchFn: fetchFn as unknown as typeof fetch,
      // Record each backoff delay and resolve immediately (no real timers).
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      // Deterministic RNG = 1 → full-jitter picks the TOP of the band, i.e.
      // exactly the (capped) exponential delay, so we can assert the cap.
      random: () => 1,
    });
  });

  it('returns immediately on a first-attempt 200 with no retries', async () => {
    fetchFn.mockResolvedValueOnce(makeResponse(200));
    const res = await client.request('https://api.example.com/x');
    expect(res.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleeps).toHaveLength(0);
  });

  it('retries transient 429s up to maxRetries then throws ProviderHttpError', async () => {
    fetchFn.mockResolvedValue(makeResponse(429));
    await expect(
      client.request('https://api.example.com/x', { label: 'oura.backfill' }),
    ).rejects.toBeInstanceOf(ProviderHttpError);

    // 1 initial attempt + maxRetries retries = maxRetries + 1 total calls.
    expect(fetchFn).toHaveBeenCalledTimes(BACKOFF_DEFAULTS.maxRetries + 1);
    // One backoff sleep between each pair of attempts = maxRetries sleeps.
    expect(sleeps).toHaveLength(BACKOFF_DEFAULTS.maxRetries);
  });

  it('exposes the attempt count and last status on the thrown error', async () => {
    fetchFn.mockResolvedValue(makeResponse(503));
    try {
      await client.request('https://api.example.com/x');
      fail('expected ProviderHttpError');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderHttpError);
      const e = err as ProviderHttpError;
      expect(e.attempts).toBe(BACKOFF_DEFAULTS.maxRetries + 1);
      expect(e.status).toBe(503);
    }
  });

  it('succeeds on the 3rd attempt after two transient failures', async () => {
    fetchFn
      .mockResolvedValueOnce(makeResponse(500))
      .mockResolvedValueOnce(makeResponse(429))
      .mockResolvedValueOnce(makeResponse(200));

    const res = await client.request('https://api.example.com/x');
    expect(res.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveLength(2);
  });

  it('does NOT retry a permanent 4xx (e.g. 400) — fails loud after one attempt', async () => {
    fetchFn.mockResolvedValue(makeResponse(400));
    await expect(client.request('https://api.example.com/x')).rejects.toThrow(
      ProviderHttpError,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleeps).toHaveLength(0);
  });

  it('does NOT retry a 401 unauthorized', async () => {
    fetchFn.mockResolvedValue(makeResponse(401));
    await expect(client.request('https://api.example.com/x')).rejects.toThrow(
      ProviderHttpError,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries network/timeout errors (rejected fetch) and then throws', async () => {
    fetchFn.mockRejectedValue(new Error('ECONNRESET'));
    await expect(client.request('https://api.example.com/x')).rejects.toBeInstanceOf(
      ProviderHttpError,
    );
    expect(fetchFn).toHaveBeenCalledTimes(BACKOFF_DEFAULTS.maxRetries + 1);
    expect(sleeps).toHaveLength(BACKOFF_DEFAULTS.maxRetries);
  });

  it('caps the backoff delay at maxDelayMs (jitter at top of band via RNG=1)', async () => {
    fetchFn.mockResolvedValue(makeResponse(429));
    // baseDelay=250 default doubles: 250, 500, 1000 — none hit the 5s cap, so
    // override the base high enough that the exponential blows past the cap.
    await expect(
      client.request('https://api.example.com/x', {
        baseDelayMs: 4000,
        maxRetries: 3,
      }),
    ).rejects.toBeInstanceOf(ProviderHttpError);

    // attempt1 delay = min(4000, 5000)=4000; attempt2 = min(8000,5000)=5000;
    // attempt3 = min(16000,5000)=5000. With RNG=1 jitter picks the top.
    expect(sleeps).toEqual([4000, 5000, 5000]);
    sleeps.forEach((d) => expect(d).toBeLessThanOrEqual(BACKOFF_DEFAULTS.maxDelayMs));
  });

  it('computeBackoffDelay grows exponentially and never exceeds the cap', () => {
    // RNG=1 → returns exactly the capped exponential value.
    expect(client.computeBackoffDelay(1, 250, 5000, 0.5)).toBe(250);
    expect(client.computeBackoffDelay(2, 250, 5000, 0.5)).toBe(500);
    expect(client.computeBackoffDelay(3, 250, 5000, 0.5)).toBe(1000);
    // Big base → capped.
    expect(client.computeBackoffDelay(5, 4000, 5000, 0.5)).toBe(5000);
  });

  it('applies the timeout via AbortController (aborts a slow fetch)', async () => {
    // A fetch that rejects with AbortError when its signal fires.
    fetchFn.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    });

    await expect(
      client.request('https://api.example.com/slow', {
        timeoutMs: 5,
        maxRetries: 0,
      }),
    ).rejects.toBeInstanceOf(ProviderHttpError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
