import { g2LedgerTestTarget } from '../utils/g2-ledger-db';

const safe = 'postgresql://user@127.0.0.1:55439/g2_ledger_expand_disposable';
const ack = 'g2_ledger_expand_disposable';
describe('G2-E dedicated disposable target boundary', () => {
  it.each([
    safe.replace('127.0.0.1', 'prod.example.com'),
    safe.replace('55439', '5432'),
    safe.replace(ack, 'c1_setup_disposable'),
    safe.replace('user@', 'user:password@'),
    safe.replace('user@', 'service_role@'),
    safe.replace('postgresql:', 'https:'),
    `${safe}#fragment`,
    `${safe}?schema=private`,
    `${safe}?host=prod.example.com`,
    `${safe}?options=-csearch_path%3Dprivate`,
    `${safe}?sslmode=disable`,
    `${safe}?schema=public&schema=private`,
    `${safe}?connect_timeout=0`,
    `${safe}?connect_timeout=11`,
    `${safe}?connection_limit=01`,
  ])('refuses unsupported target before any connection: %s', (value) => {
    expect(() => g2LedgerTestTarget(value, ack)).toThrow();
  });
  it('requires explicit matching confirmation', () => {
    expect(() => g2LedgerTestTarget(safe)).toThrow();
    expect(() => g2LedgerTestTarget(safe, 'c1_setup_disposable')).toThrow();
  });
  it('retains bounded timeout and strips only Prisma-only options for psql', () => {
    const target = g2LedgerTestTarget(`${safe}?schema=public&connection_limit=2`, ack);
    expect(target.prismaUrl).toContain('schema=public');
    expect(target.prismaUrl).toContain('connection_limit=2');
    expect(target.psqlUrl).toBe(`${safe}?connect_timeout=5`);
  });
});
