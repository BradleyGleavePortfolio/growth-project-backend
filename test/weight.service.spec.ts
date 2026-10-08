/**
 * CF-BODY-J2-128 — a client can fix or remove a wrong weigh-in.
 *
 * PATCH /weight/:id (weight_lbs, notes) and DELETE /weight/:id write with
 * `where: { id, user_id: <caller> }`, so a weigh-in that is not the caller's
 * answers 404 and is never read or changed. Each successful write busts the
 * AI context cache so Roman stops quoting the old number.
 *
 * Unit tests with a mocked Prisma (no database).
 */
import {
  BadRequestException,
  HttpStatus,
  NotFoundException,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { ClientAIContextService } from '../src/ai/client-ai-context.service';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { PrismaService } from '../src/prisma.service';
import { PtmService } from '../src/ptm/ptm.service';
import { WeightController } from '../src/weight/weight.controller';
import { UpdateWeightDto } from '../src/weight/weight.dto';
import { WeightService } from '../src/weight/weight.service';
import { makeUser } from './community/challenges/test-user.factory';

const CLIENT = 'client-a';
const ENTRY = 'weigh-in-1';
const ROW = {
  id: ENTRY,
  user_id: CLIENT,
  date: new Date('2026-10-07T00:00:00.000Z'),
  weight_lbs: 181.2,
  notes: null,
  logged_at: new Date('2026-10-07T08:00:00.000Z'),
};

async function makeService() {
  const prisma = {
    weightLog: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(ROW),
      create: jest.fn(),
    },
  };
  const ptm = { emit: jest.fn() };
  const aiContext = { invalidateForUser: jest.fn() };
  const moduleRef = await Test.createTestingModule({
    providers: [
      WeightService,
      { provide: PrismaService, useValue: prisma },
      { provide: PtmService, useValue: ptm },
      { provide: ClientAIContextService, useValue: aiContext },
    ],
  }).compile();
  return { prisma, ptm, aiContext, service: moduleRef.get(WeightService) };
}

describe('WeightService.updateWeight', () => {
  it('changes only the caller-owned weigh-in and returns the saved row', async () => {
    const { prisma, aiContext, ptm, service } = await makeService();
    await expect(service.updateWeight(CLIENT, ENTRY, { weight_lbs: 181.2 })).resolves.toEqual(ROW);
    expect(prisma.weightLog.updateMany).toHaveBeenCalledWith({
      where: { id: ENTRY, user_id: CLIENT },
      data: { weight_lbs: 181.2, notes: undefined },
    });
    expect(prisma.weightLog.findFirst).toHaveBeenCalledWith({ where: { id: ENTRY, user_id: CLIENT } });
    expect(aiContext.invalidateForUser).toHaveBeenCalledWith(CLIENT);
    expect(prisma.weightLog.create).not.toHaveBeenCalled();
    expect(ptm.emit).not.toHaveBeenCalled();
  });

  it('clears the note when notes is null', async () => {
    const { prisma, service } = await makeService();
    await service.updateWeight(CLIENT, ENTRY, { notes: null });
    expect(prisma.weightLog.updateMany).toHaveBeenCalledWith({
      where: { id: ENTRY, user_id: CLIENT },
      data: { weight_lbs: undefined, notes: null },
    });
  });

  it("answers 404 for another person's or a missing weigh-in and changes nothing", async () => {
    const { prisma, aiContext, service } = await makeService();
    prisma.weightLog.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.updateWeight('client-b', ENTRY, { weight_lbs: 150 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.weightLog.updateMany).toHaveBeenCalledWith({
      where: { id: ENTRY, user_id: 'client-b' },
      data: { weight_lbs: 150, notes: undefined },
    });
    expect(prisma.weightLog.findFirst).not.toHaveBeenCalled();
    expect(aiContext.invalidateForUser).not.toHaveBeenCalled();
  });

  it('rejects an edit with nothing to change before touching the database', async () => {
    const { prisma, aiContext, service } = await makeService();
    await expect(service.updateWeight(CLIENT, ENTRY, {})).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.weightLog.updateMany).not.toHaveBeenCalled();
    expect(aiContext.invalidateForUser).not.toHaveBeenCalled();
  });
});

describe('WeightService.deleteWeight', () => {
  it('deletes only the caller-owned weigh-in', async () => {
    const { prisma, aiContext, service } = await makeService();
    await expect(service.deleteWeight(CLIENT, ENTRY)).resolves.toBeUndefined();
    expect(prisma.weightLog.deleteMany).toHaveBeenCalledWith({ where: { id: ENTRY, user_id: CLIENT } });
    expect(aiContext.invalidateForUser).toHaveBeenCalledWith(CLIENT);
  });

  it("answers 404 for another person's or a missing weigh-in", async () => {
    const { prisma, aiContext, service } = await makeService();
    prisma.weightLog.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service.deleteWeight('client-b', ENTRY)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.weightLog.deleteMany).toHaveBeenCalledWith({ where: { id: ENTRY, user_id: 'client-b' } });
    expect(aiContext.invalidateForUser).not.toHaveBeenCalled();
  });
});

describe('UpdateWeightDto under the global validation pipe', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const validate = (body: Record<string, unknown>) =>
    pipe.transform(body, { type: 'body', metatype: UpdateWeightDto });

  it('accepts a new weight, a new note, or a cleared note', async () => {
    await expect(validate({ weight_lbs: 181.2 })).resolves.toMatchObject({ weight_lbs: 181.2 });
    await expect(validate({ notes: 'After breakfast' })).resolves.toMatchObject({ notes: 'After breakfast' });
    await expect(validate({ notes: null })).resolves.toMatchObject({ notes: null });
  });

  it.each<[string, Record<string, unknown>]>([
    ['a weight under 40 lb', { weight_lbs: 20 }],
    ['a weight over 1,500 lb', { weight_lbs: 1800 }],
    ['a null weight', { weight_lbs: null }],
    ['a weight sent as text', { weight_lbs: '181' }],
    ['a note over 500 characters', { notes: 'x'.repeat(501) }],
    ['a date change', { date: '2026-10-01' }],
    ['an owner change', { user_id: 'client-b' }],
  ])('rejects %s', async (_label, body) => {
    await expect(validate(body)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('WeightController edit and delete routes', () => {
  it('are PATCH /weight/:id and DELETE /weight/:id (204) behind the client guards', () => {
    const proto = WeightController.prototype;
    expect(Reflect.getMetadata(PATH_METADATA, WeightController)).toBe('weight');
    expect(Reflect.getMetadata(METHOD_METADATA, proto.updateWeight)).toBe(RequestMethod.PATCH);
    expect(Reflect.getMetadata(PATH_METADATA, proto.updateWeight)).toBe(':id');
    expect(Reflect.getMetadata(METHOD_METADATA, proto.deleteWeight)).toBe(RequestMethod.DELETE);
    expect(Reflect.getMetadata(PATH_METADATA, proto.deleteWeight)).toBe(':id');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.deleteWeight)).toBe(HttpStatus.NO_CONTENT);
    expect(Reflect.getMetadata(GUARDS_METADATA, WeightController)).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, WeightController)).toEqual(['student']);
    // No per-route override of the class-level student gate.
    expect(Reflect.getMetadata(ROLES_KEY, proto.updateWeight)).toBeUndefined();
    expect(Reflect.getMetadata(ROLES_KEY, proto.deleteWeight)).toBeUndefined();
  });

  it('pass the signed-in user id, never an id from the request body', async () => {
    const weightService = {
      updateWeight: jest.fn().mockResolvedValue(ROW),
      deleteWeight: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [WeightController],
      providers: [{ provide: WeightService, useValue: weightService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const controller = moduleRef.get(WeightController);
    const req = { user: makeUser({ id: CLIENT, role: 'student' }) };

    await expect(controller.updateWeight(req, ENTRY, { weight_lbs: 181.2 })).resolves.toEqual(ROW);
    expect(weightService.updateWeight).toHaveBeenCalledWith(CLIENT, ENTRY, { weight_lbs: 181.2 });
    await expect(controller.deleteWeight(req, ENTRY)).resolves.toBeUndefined();
    expect(weightService.deleteWeight).toHaveBeenCalledWith(CLIENT, ENTRY);
  });
});
