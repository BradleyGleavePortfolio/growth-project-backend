/** Sol B-355-1 replay at the real three-argument coachApi.getClients seam. */
const mockGetClients = jest.fn();
jest.mock('../../services/api', () => ({
  __esModule: true,
  default: {},
  coachApi: { getClients: (...args: unknown[]) => mockGetClients(...args) },
}));
import { programsApi } from '../programsApi';

const all = Array.from({ length: 25 }, (_, i) => ({
  id: `client-${String(i).padStart(2, '0')}`,
  name: `Client ${String(i).padStart(2, '0')}`,
  email: `synthetic-${i}@example.invalid`,
  archived_at: null,
}));

beforeEach(() => mockGetClients.mockReset());

it('returns all 25 clients using the last-row cursor and real take parameter', async () => {
  mockGetClients.mockImplementation(async (status: string, cursor?: string, take?: number) => {
    expect(status).toBe('active');
    const from = cursor ? all.findIndex((row) => row.id === cursor) + 1 : 0;
    return { data: all.slice(from, from + (take ?? 20)) };
  });
  const rows = await programsApi.assignableClients();
  expect(rows.map((row) => row.id)).toEqual(all.map((row) => row.id));
  expect(mockGetClients.mock.calls).toEqual([
    ['active', undefined, 20],
    ['active', 'client-19', 20],
  ]);
});

it('does not return a seemingly complete first page when the second page fails', async () => {
  mockGetClients.mockResolvedValueOnce({ data: all.slice(0, 20) });
  mockGetClients.mockRejectedValueOnce({ response: { status: 503 } });
  await expect(programsApi.assignableClients()).rejects.toMatchObject({
    response: { status: 503 },
  });
});
