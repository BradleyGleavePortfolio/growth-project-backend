import { InviteCodesService } from '../src/invite-codes/invite-codes.service';

// parsePasted is pure; we exercise it without a Prisma stub. The DB
// path of bulkInvite is exercised by the integration suite.

describe('InviteCodesService.parsePasted', () => {
  const svc = new InviteCodesService(
    // @ts-expect-error — parser path is pure; deps unused.
    null,
    null,
  );

  it('parses one email per line', () => {
    const rows = svc.parsePasted('alice@example.com\nbob@example.com\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ email: 'alice@example.com' });
    expect(rows[1]).toEqual({ email: 'bob@example.com' });
  });

  it('parses comma-separated email,name pairs', () => {
    const rows = svc.parsePasted('alice@example.com, Alice Smith');
    expect(rows[0]).toEqual({ email: 'alice@example.com', name: 'Alice Smith' });
  });

  it('parses email,name,note triples and trims fields', () => {
    const rows = svc.parsePasted('  alice@example.com , Alice , welcome aboard ');
    expect(rows[0]).toEqual({
      email: 'alice@example.com',
      name: 'Alice',
      note: 'welcome aboard',
    });
  });

  it('accepts tab-separated values', () => {
    const rows = svc.parsePasted('alice@example.com\tAlice');
    expect(rows[0]).toEqual({ email: 'alice@example.com', name: 'Alice' });
  });

  it('drops blank lines', () => {
    const rows = svc.parsePasted('\n\nalice@example.com\n\n');
    expect(rows).toHaveLength(1);
  });

  it('caps results at maxRows', () => {
    const input = Array.from({ length: 50 }, (_, i) => `u${i}@x.com`).join('\n');
    const rows = svc.parsePasted(input, 10);
    expect(rows).toHaveLength(10);
  });
});
