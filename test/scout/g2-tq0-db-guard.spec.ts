import { g2Tq0TestTarget } from '../utils/g2-tq0-db';

const base = 'postgresql://user@127.0.0.1:55439/g2_tq0_disposable';
describe('T/Q0 disposable target guard', () => {
  it('requires its own confirmed target and strips only Prisma options for psql', () => {
    expect(g2Tq0TestTarget(`${base}?schema=public&connection_limit=2`, 'g2_tq0_disposable'))
      .toEqual({
        prismaUrl: `${base}?schema=public&connection_limit=2&connect_timeout=5`,
        psqlUrl: `${base}?connect_timeout=5`,
      });
  });
  it.each([
    base.replace('127.0.0.1', 'localhost'), base.replace('55439', '5432'),
    base.replace('g2_tq0_disposable', 'g2_ledger_expand_disposable'),
    base.replace('user@', 'service_role@'), base.replace('user@', 'user:secret@'),
    `${base}?host=remote`, `${base}?schema=private`, `${base}?connection_limit=0`,
    `${base}?connect_timeout=11`, `${base}?schema=public&schema=public`, `${base}#fragment`,
  ])('refuses unsafe/ambiguous target %s', (url) => {
    expect(() => g2Tq0TestTarget(url, 'g2_tq0_disposable')).toThrow();
  });
  it('refuses absent or mistaken confirmation', () => {
    expect(() => g2Tq0TestTarget(base)).toThrow();
    expect(() => g2Tq0TestTarget(base, 'g2_ledger_expand_disposable')).toThrow();
  });
});
