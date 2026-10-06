import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExerciseCatalogListQueryDto } from '../src/exercise-catalog/exercise-catalog.dto';
import { ExerciseCatalogService } from '../src/exercise-catalog/exercise-catalog.service';
import { PrismaService } from '../src/prisma.service';
import { MuxService } from '../src/video/mux.service';

describe('exercise catalog launch requests', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const metadata = { type: 'query' as const, metatype: ExerciseCatalogListQueryDto };

  it('accepts the limit=20 query sent by the exercise browser', async () => {
    const query = await pipe.transform({ limit: '20', q: 'bench press' }, metadata);
    expect(query).toMatchObject({ limit: 20, q: 'bench press' });
  });

  it.each(['0', '101', 'not-a-number'])('still rejects an invalid page size %s', async (limit) => {
    await expect(pipe.transform({ limit }, metadata)).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    { q: 'bench press', words: ['bench', 'press'] },
    { q: 'push-up', words: ['push', 'up'] },
    { q: 'pullup', words: ['pull', 'up'] },
    { q: 'RDL', words: ['romanian', 'deadlift'] },
    { q: 'OHP', words: ['overhead', 'press'] },
  ])('matches common lift query $q by words', async ({ q, words }) => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = Object.assign(new PrismaService(), {
      exerciseCatalogItem: { findMany, count: jest.fn().mockResolvedValue(0) },
      $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
    });
    const service = new ExerciseCatalogService(prisma, new MuxService(new ConfigService()));
    await service.list({ q });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        AND: words.map((word) => ({ name: { contains: word, mode: 'insensitive' } })),
      },
    }));
  });

  it('resolves the seed source id used by assigned workout exercise info', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const prisma = Object.assign(new PrismaService(), {
      exerciseCatalogItem: { findFirst },
    });
    const service = new ExerciseCatalogService(prisma, new MuxService(new ConfigService()));
    await expect(service.getByIdOrSlug('seed:push-001')).rejects.toThrow('not found');
    expect(findFirst).toHaveBeenCalledWith({
      where: { OR: [
        { id: 'seed:push-001' },
        { slug: 'seed:push-001' },
        { source_ref: 'seed:push-001' },
      ] },
    });
  });
});
