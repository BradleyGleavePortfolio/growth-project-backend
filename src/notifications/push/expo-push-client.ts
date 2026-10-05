import type { ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from 'expo-server-sdk';

// The Expo Push API transport used by PushDeliveryService (B-648-6).
//
// expo-server-sdk's client takes no AbortSignal, so a stalled Expo request
// could not be cancelled. This client calls the same two documented
// endpoints with the runtime's fetch and a caller-owned AbortSignal, so
// every send and receipt fetch has a real, cancelling deadline.
//
//   POST https://exp.host/--/api/v2/push/send         body: ExpoPushMessage[]
//   POST https://exp.host/--/api/v2/push/getReceipts  body: { ids: string[] }
//
// Same configuration as the existing senders: no access token (the Expo
// project does not use "enhanced push security").

export const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
/** Expo accepts at most 100 messages per send and 1,000 ids per receipt call. */
export const EXPO_SEND_CHUNK = 100;
export const EXPO_RECEIPT_CHUNK = 1000;

export interface ExpoPushClient {
  send(messages: ExpoPushMessage[], signal: AbortSignal): Promise<ExpoPushTicket[]>;
  getReceipts(ids: string[], signal: AbortSignal): Promise<Record<string, ExpoPushReceipt>>;
}

/**
 * Expo answered with an HTTP error. `retryable` is true for 429 and 5xx:
 * Expo did not accept the request, so a later retry cannot double-send.
 */
export class ExpoHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryable: boolean,
    readonly code: string | null,
  ) {
    super(`Expo push API answered HTTP ${status}${code ? ` (${code})` : ''}`);
    this.name = 'ExpoHttpError';
  }
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface ExpoEnvelope<T> {
  data?: T;
  errors?: Array<{ code?: string; message?: string }>;
}

export class FetchExpoPushClient implements ExpoPushClient {
  constructor(private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init)) {}

  async send(messages: ExpoPushMessage[], signal: AbortSignal): Promise<ExpoPushTicket[]> {
    const data = await this.post<ExpoPushTicket[]>(EXPO_SEND_URL, messages, signal);
    return Array.isArray(data) ? data : [];
  }

  async getReceipts(ids: string[], signal: AbortSignal): Promise<Record<string, ExpoPushReceipt>> {
    const data = await this.post<Record<string, ExpoPushReceipt>>(
      EXPO_RECEIPTS_URL,
      { ids },
      signal,
    );
    return data && typeof data === 'object' ? data : {};
  }

  private async post<T>(url: string, body: unknown, signal: AbortSignal): Promise<T | undefined> {
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'accept-encoding': 'gzip, deflate',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    let parsed: ExpoEnvelope<T> | null = null;
    try {
      parsed = (await res.json()) as ExpoEnvelope<T>;
    } catch {
      parsed = null;
    }
    const code = parsed?.errors?.[0]?.code ?? null;
    if (!res.ok) {
      throw new ExpoHttpError(res.status, res.status === 429 || res.status >= 500, code);
    }
    if (!parsed || parsed.data === undefined) {
      // A 200 without data is a request-level error (for example
      // PUSH_TOO_MANY_EXPERIENCE_IDS). Not retryable: the same body fails again.
      throw new ExpoHttpError(res.status, false, code ?? 'NO_DATA');
    }
    return parsed.data;
  }
}

/** An AbortSignal that aborts after `ms`; the timer never holds the process open. */
export function deadlineSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const reason = new Error(`push transport deadline of ${ms} ms passed`);
    reason.name = 'TimeoutError';
    controller.abort(reason);
  }, ms);
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}
