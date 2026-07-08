import { ExtensionPairController } from '../extension-pair.controller';
import { asPairServiceDouble, authedRequest } from './test-doubles.test';

function makeService() {
  return {
    init: jest.fn().mockResolvedValue({ pairing_code: '142856', expires_at: 'ISO' }),
    status: jest.fn().mockResolvedValue({ status: 'pending' }),
    redeem: jest.fn().mockResolvedValue({
      access_token: 'a',
      refresh_token: 'r',
      chosen_platform: 'truecoach',
    }),
  };
}

const reqAs = authedRequest;

describe('ExtensionPairController', () => {
  let service: ReturnType<typeof makeService>;
  let controller: ExtensionPairController;

  beforeEach(() => {
    service = makeService();
    controller = new ExtensionPairController(asPairServiceDouble(service));
  });

  describe('init', () => {
    it('binds the code to the authenticated coach id, not a body field', async () => {
      const result = await controller.init(reqAs('coach-1'), { chosen_platform: 'truecoach' });
      expect(service.init).toHaveBeenCalledWith('coach-1', 'truecoach');
      expect(result).toEqual({ pairing_code: '142856', expires_at: 'ISO' });
    });
  });

  describe('status', () => {
    it('scopes the poll to the caller and forwards the body code', async () => {
      const result = await controller.status(reqAs('coach-1'), { code: '142856' });
      expect(service.status).toHaveBeenCalledWith('coach-1', '142856');
      expect(result).toEqual({ status: 'pending' });
    });

    it('reads the code from the request body, never a query string', async () => {
      await controller.status(reqAs('coach-2'), { code: '000042' });
      expect(service.status).toHaveBeenCalledWith('coach-2', '000042');
    });
  });

  describe('redeem', () => {
    it('forwards the code and returns the token bundle', async () => {
      const result = await controller.redeem({ code: '142856' });
      expect(service.redeem).toHaveBeenCalledWith('142856');
      expect(result).toEqual({
        access_token: 'a',
        refresh_token: 'r',
        chosen_platform: 'truecoach',
      });
    });
  });
});
