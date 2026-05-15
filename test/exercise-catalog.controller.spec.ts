import { HttpException, HttpStatus } from '@nestjs/common';
import {
  AdminExerciseCatalogController,
  ExerciseCatalogController,
} from '../src/exercise-catalog/exercise-catalog.controller';
import { ExerciseCatalogService } from '../src/exercise-catalog/exercise-catalog.service';
import { MuxDisabledError } from '../src/video/mux.errors';

describe('ExerciseCatalogController', () => {
  it('delegates list() straight to the service', async () => {
    const svc = {
      list: jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 }),
    } as unknown as ExerciseCatalogService;
    const c = new ExerciseCatalogController(svc);
    const out = await c.list({});
    expect(out.total).toBe(0);
    expect(svc.list).toHaveBeenCalledWith({});
  });

  it('detail returns the service response unchanged (incl. playbackUrl)', async () => {
    const svc = {
      getByIdOrSlug: jest.fn().mockResolvedValue({
        id: 'x',
        slug: 's',
        playbackUrl: 'https://stream.mux.com/pb.m3u8',
      }),
    } as unknown as ExerciseCatalogService;
    const c = new ExerciseCatalogController(svc);
    const out = await c.detail('s');
    expect(out.playbackUrl).toBe('https://stream.mux.com/pb.m3u8');
  });
});

describe('AdminExerciseCatalogController (Mux-disabled mapping)', () => {
  function controllerWith(svc: Partial<ExerciseCatalogService>) {
    return new AdminExerciseCatalogController(svc as ExerciseCatalogService);
  }

  it('createUpload translates MuxDisabledError → 503 { error: mux_disabled, action }', async () => {
    const svc: Partial<ExerciseCatalogService> = {
      createUpload: jest
        .fn()
        .mockRejectedValue(new MuxDisabledError('Set MUX_TOKEN_ID and MUX_TOKEN_SECRET.')),
    };
    const c = controllerWith(svc);
    try {
      await c.createUpload('item_x', {});
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect((err as HttpException).getResponse()).toEqual({
        error: 'mux_disabled',
        action: expect.stringContaining('MUX_TOKEN_ID'),
      });
    }
  });

  it('attach translates MuxDisabledError to 503', async () => {
    const svc: Partial<ExerciseCatalogService> = {
      attachAsset: jest
        .fn()
        .mockRejectedValue(new MuxDisabledError('Set Mux env vars to attach assets.')),
    };
    const c = controllerWith(svc);
    await expect(c.attach('item_x', { muxAssetId: 'a' })).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
  });

  it('non-Mux errors pass through unchanged', async () => {
    const svc: Partial<ExerciseCatalogService> = {
      attachAsset: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const c = controllerWith(svc);
    await expect(c.attach('item_x', { muxAssetId: 'a' })).rejects.toThrow('boom');
  });
});
