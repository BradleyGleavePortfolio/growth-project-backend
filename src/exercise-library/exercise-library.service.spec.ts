/**
 * Unit tests for ExerciseLibraryService.
 * The HTTP client (fetch) is mocked via jest.spyOn so no real network calls
 * are made.  Redis is not injected — the service falls back to the in-memory
 * LRU cache automatically.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { ExerciseLibraryService } from './exercise-library.service';
import type { Exercise } from './exercise.entity';

const MOCK_EXERCISE: Exercise = {
  id: '0001',
  name: 'barbell bench press',
  bodyPart: 'chest',
  equipment: 'barbell',
  target: 'pectorals',
  secondaryMuscles: ['triceps', 'deltoids'],
  instructions: ['Lie on bench', 'Lower bar to chest', 'Press up'],
  gifUrl: 'https://cdn.exercisedb.io/0001.gif',
  video_url: null,
  video_provider: null,
};

function mockFetch(data: unknown, status = 200) {
  return jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as Response);
}

describe('ExerciseLibraryService', () => {
  let service: ExerciseLibraryService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExerciseLibraryService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'EXERCISEDB_API_KEY') return 'test-key';
              if (key === 'EXERCISEDB_API_HOST') return undefined; // use default
              if (key === 'REDIS_URL') return undefined;            // no Redis
              return undefined;
            },
          },
        },
      ],
    }).compile();

    service = module.get<ExerciseLibraryService>(ExerciseLibraryService);
    // Bypass Redis init (onModuleInit would attempt a connection)
    await service.onModuleInit();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('searchExercises', () => {
    it('returns paginated results for a name query', async () => {
      const mockFetchSpy = mockFetch([MOCK_EXERCISE, MOCK_EXERCISE, MOCK_EXERCISE]);

      const result = await service.searchExercises({ q: 'bench press', limit: 2 });

      expect(mockFetchSpy).toHaveBeenCalledTimes(1);
      const calledUrl = (mockFetchSpy.mock.calls[0][0] as string);
      expect(calledUrl).toContain('/exercises/name/bench%20press');

      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(3);
      expect(result.nextCursor).not.toBeNull();
    });

    it('serves subsequent requests from cache without calling fetch', async () => {
      const spy = mockFetch([MOCK_EXERCISE]);
      await service.searchExercises({ q: 'bench press', limit: 10 });
      await service.searchExercises({ q: 'bench press', limit: 10 });

      expect(spy).toHaveBeenCalledTimes(1); // second call hits cache
    });

    it('filters by muscleGroup when q is absent', async () => {
      const spy = mockFetch([MOCK_EXERCISE]);
      await service.searchExercises({ muscleGroup: 'chest', limit: 10 });

      expect(spy.mock.calls[0][0]).toContain('/exercises/bodyPart/chest');
    });

    it('returns empty page when API returns empty array', async () => {
      mockFetch([]);
      const result = await service.searchExercises({ q: 'nonexistent' });

      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.nextCursor).toBeNull();
    });
  });

  describe('getExerciseById', () => {
    it('returns the exercise when found', async () => {
      mockFetch(MOCK_EXERCISE);
      const exercise = await service.getExerciseById('0001');
      expect(exercise.id).toBe('0001');
      expect(exercise.name).toBe('barbell bench press');
    });

    it('throws NotFoundException when API returns empty object', async () => {
      mockFetch({});
      await expect(service.getExerciseById('9999')).rejects.toThrow(NotFoundException);
    });

    it('throws when API returns a non-200 status', async () => {
      mockFetch({ message: 'Not Found' }, 404);
      await expect(service.getExerciseById('bad')).rejects.toThrow();
    });
  });
});
