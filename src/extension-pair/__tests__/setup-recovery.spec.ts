import { ExtensionPairService } from '../extension-pair.service';
import { asAuthDouble, asPrismaDouble, withSetupTransaction } from './test-doubles.test';

const nonce = 'c9e88b27-9f56-48e8-b0ee-df16d363ce58';
function setup() {
  const row = {
    id: '99457965-6db2-4dcb-bde3-05c843b681fa',
    chosen_platform: 'truecoach',
    superseded_at: null,
    challenge: {
      code: '012345',
      used_at: null,
      failed_attempts: 0,
      expires_at: new Date(Date.now() + 120000),
    },
  };
  const prisma = withSetupTransaction({
    extensionPairCode: {
      create: jest.fn(),
      updateMany: jest.fn(),
    },
  });
  prisma.importIntent.findUnique.mockResolvedValue(row);
  const auth = { mintExtensionSessionForCoach: jest.fn() };
  return {
    row,
    prisma,
    auth,
    svc: new ExtensionPairService(asPrismaDouble(prisma), asAuthDouble(auth)),
  };
}

describe('C1-S1 nonce recovery', () => {
  it('replays the exact ID/code/expiry without mutation or minting', async () => {
    const { svc, row, prisma, auth } = setup();
    const expected = {
      import_intent_id: row.id,
      pairing_code: row.challenge.code,
      expires_at: row.challenge.expires_at.toISOString(),
    };
    expect(await svc.init('coach-1', 'truecoach', nonce)).toEqual(expected);
    expect(await svc.init('coach-1', 'truecoach', nonce)).toEqual(expected);
    expect(prisma.importIntent.findUnique).toHaveBeenCalledWith({
      where: { coach_id_setup_nonce: { coach_id: 'coach-1', setup_nonce: nonce } },
      include: { challenge: true },
    });
    expect(prisma.importIntent.create).not.toHaveBeenCalled();
    expect(prisma.importIntent.updateMany).not.toHaveBeenCalled();
    expect(prisma.extensionPairCode.create).not.toHaveBeenCalled();
    expect(auth.mintExtensionSessionForCoach).not.toHaveBeenCalled();
  });

  it('conflicting platform returns 409 before mutation', async () => {
    const { svc, prisma } = setup();
    await expect(svc.init('coach-1', 'other', nonce)).rejects.toMatchObject({
      status: 409,
      response: { code: 'setup_nonce_conflict' },
    });
    expect(prisma.importIntent.updateMany).not.toHaveBeenCalled();
  });

  it.each(['expired', 'used', 'locked', 'superseded', 'retired'])(
    'unavailable challenge (%s) returns 410 without replacing it',
    async (reason) => {
      const { svc, row, prisma } = setup();
      if (reason === 'expired') row.challenge.expires_at = new Date(0);
      if (reason === 'used') Object.assign(row.challenge, { used_at: new Date() });
      if (reason === 'locked') row.challenge.failed_attempts = 5;
      if (reason === 'superseded') Object.assign(row, { superseded_at: new Date() });
      if (reason === 'retired') Object.assign(row, { challenge: null });
      await expect(svc.init('coach-1', 'truecoach', nonce)).rejects.toMatchObject({
        status: 410,
        response: { code: 'setup_challenge_unavailable' },
      });
      expect(prisma.importIntent.create).not.toHaveBeenCalled();
      expect(prisma.importIntent.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each([['id'], ['coach_id', 'setup_nonce'], undefined])(
    'does not retry a non-code or unidentified unique constraint %s',
    async (target) => {
      const { svc, prisma } = setup();
      prisma.importIntent.findUnique.mockResolvedValue(null);
      const error = { code: 'P2002', meta: { target } };
      prisma.importIntent.create.mockRejectedValue(error);
      await expect(svc.init('coach-1', 'truecoach', nonce)).rejects.toEqual(error);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    },
  );
});
