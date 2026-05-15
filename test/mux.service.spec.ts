import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { MuxService } from '../src/video/mux.service';
import { MuxDisabledError } from '../src/video/mux.errors';

function makeConfig(values: Record<string, string | undefined>): ConfigService {
  return {
    get<T = string>(key: string): T | undefined {
      return values[key] as T | undefined;
    },
  } as ConfigService;
}

function signMuxPayload(payload: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${sig}`;
}

describe('MuxService', () => {
  // ── isConfigured ────────────────────────────────────────────────────────

  it('reports unconfigured when MUX_TOKEN_ID is missing', () => {
    const svc = new MuxService(makeConfig({}));
    expect(svc.isConfigured()).toBe(false);
  });

  it('reports configured when both Mux secrets are present', () => {
    const svc = new MuxService(
      makeConfig({ MUX_TOKEN_ID: 'id', MUX_TOKEN_SECRET: 'secret' }),
    );
    expect(svc.isConfigured()).toBe(true);
  });

  // ── owner-only operations throw MuxDisabledError when unconfigured ──────

  it('createDirectUpload throws MuxDisabledError when Mux is not configured', async () => {
    const svc = new MuxService(makeConfig({}));
    await expect(svc.createDirectUpload()).rejects.toBeInstanceOf(MuxDisabledError);
  });

  it('getAsset throws MuxDisabledError when Mux is not configured', async () => {
    const svc = new MuxService(makeConfig({}));
    await expect(svc.getAsset('asset_x')).rejects.toBeInstanceOf(MuxDisabledError);
  });

  it('createDirectUpload posts to /video/v1/uploads with Basic auth', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { id: 'upl_123', url: 'https://upload.example/x' } }),
      text: async () => '',
    } as unknown as Response);

    const svc = new MuxService(
      makeConfig({ MUX_TOKEN_ID: 'id-a', MUX_TOKEN_SECRET: 'secret-b' }),
    );
    const out = await svc.createDirectUpload({ playbackPolicy: 'public' });
    expect(out).toEqual({ uploadId: 'upl_123', url: 'https://upload.example/x' });

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://api.mux.com/video/v1/uploads');
    expect((opts as any).headers.Authorization).toBe(
      `Basic ${Buffer.from('id-a:secret-b').toString('base64')}`,
    );
    const body = JSON.parse((opts as any).body);
    expect(body.new_asset_settings.playback_policy).toEqual(['public']);

    fetchSpy.mockRestore();
  });

  // ── mintPlaybackUrl ─────────────────────────────────────────────────────

  it('mintPlaybackUrl returns a bare HLS URL for public playback', () => {
    const svc = new MuxService(makeConfig({}));
    const url = svc.mintPlaybackUrl({ playbackId: 'pb_abc', policy: 'public' });
    expect(url).toBe('https://stream.mux.com/pb_abc.m3u8');
  });

  it('mintPlaybackUrl throws MuxDisabledError for signed without signing key env', () => {
    const svc = new MuxService(makeConfig({}));
    expect(() =>
      svc.mintPlaybackUrl({ playbackId: 'pb_abc', policy: 'signed' }),
    ).toThrow(MuxDisabledError);
  });

  // ── verifyWebhookSignature ──────────────────────────────────────────────

  describe('verifyWebhookSignature', () => {
    const secret = 'whsec_mux_test';

    it('returns false when MUX_WEBHOOK_SECRET is unset', () => {
      const svc = new MuxService(makeConfig({}));
      expect(
        svc.verifyWebhookSignature({
          payload: '{}',
          signatureHeader: signMuxPayload('{}', secret),
        }),
      ).toBe(false);
    });

    it('accepts a freshly-signed payload', () => {
      const svc = new MuxService(makeConfig({ MUX_WEBHOOK_SECRET: secret }));
      const payload = JSON.stringify({ type: 'video.asset.ready' });
      const header = signMuxPayload(payload, secret);
      expect(svc.verifyWebhookSignature({ payload, signatureHeader: header })).toBe(true);
    });

    it('rejects a tampered body', () => {
      const svc = new MuxService(makeConfig({ MUX_WEBHOOK_SECRET: secret }));
      const payload = JSON.stringify({ type: 'video.asset.ready' });
      const header = signMuxPayload(payload, secret);
      expect(
        svc.verifyWebhookSignature({ payload: payload + 'x', signatureHeader: header }),
      ).toBe(false);
    });

    it('rejects when the signing secret is different', () => {
      const svc = new MuxService(makeConfig({ MUX_WEBHOOK_SECRET: 'wrong' }));
      const payload = JSON.stringify({ type: 'video.asset.ready' });
      const header = signMuxPayload(payload, secret);
      expect(svc.verifyWebhookSignature({ payload, signatureHeader: header })).toBe(false);
    });

    it('rejects timestamps outside the tolerance window', () => {
      const svc = new MuxService(makeConfig({ MUX_WEBHOOK_SECRET: secret }));
      const payload = JSON.stringify({ type: 'video.asset.ready' });
      const stale = Math.floor(Date.now() / 1000) - 10_000;
      const header = signMuxPayload(payload, secret, stale);
      expect(svc.verifyWebhookSignature({ payload, signatureHeader: header })).toBe(false);
    });

    it('rejects a malformed header', () => {
      const svc = new MuxService(makeConfig({ MUX_WEBHOOK_SECRET: secret }));
      expect(
        svc.verifyWebhookSignature({ payload: '{}', signatureHeader: 'not-a-header' }),
      ).toBe(false);
    });

    it('rejects a missing header', () => {
      const svc = new MuxService(makeConfig({ MUX_WEBHOOK_SECRET: secret }));
      expect(
        svc.verifyWebhookSignature({ payload: '{}', signatureHeader: null }),
      ).toBe(false);
    });
  });
});
