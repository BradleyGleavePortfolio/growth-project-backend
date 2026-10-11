/**
 * PATCH /users/me/push-token: a phone's Expo push token belongs to one
 * account at a time, so when someone else signs in on a shared phone, the
 * account signed in before stops getting its notifications.
 */
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { UpdatePushTokenDto } from '../src/users/dto/update-push-token.dto';
import { UsersService } from '../src/users/users.service';

// The shape the app gets from Expo's getExpoPushTokenAsync.
const PHONE = 'ExponentPushToken[abcdefghijklmnopqrstuv]';
const OTHER_PHONE = 'ExponentPushToken[zyxwvutsrqponmlkjihgfe]';
// The older bare-UUID form, which Expo's own validator also accepts.
const UUID_TOKEN = 'F5741A13-BCDA-434B-A316-5DC0E6FFA94F';

type Data = { expo_push_token: string | null };

// In-memory User table (user id -> expo_push_token). Only the transaction
// client can touch it: the main client has nothing but $transaction, so a
// lock or write outside the transaction fails the test.
function world(tokens: Record<string, string | null>) {
  const calls: string[] = [];
  const tx = {
    $executeRaw: jest.fn(async (sql: TemplateStringsArray, ...params: unknown[]) => {
      calls.push(`${sql.join('?')} [${params.join()}]`);
      return 1;
    }),
    user: {
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { expo_push_token: string; id: { not: string } };
          data: Data;
        }) => {
          calls.push(`clear ${where.expo_push_token}`);
          const ids = Object.keys(tokens).filter(
            (id) => tokens[id] === where.expo_push_token && id !== where.id.not,
          );
          for (const id of ids) tokens[id] = data.expo_push_token;
          return { count: ids.length };
        },
      ),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Data }) => {
        calls.push(`set ${where.id}`);
        tokens[where.id] = data.expo_push_token;
      }),
    },
  };
  const db = { $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) };
  return { service: new UsersService(Object.create(db)), calls };
}

describe('UsersService.updatePushToken', () => {
  it.each([PHONE, UUID_TOKEN])(
    'registering %s on account B takes it off account A',
    async (token) => {
      const tokens = { a: token, b: null, c: OTHER_PHONE };
      await world(tokens).service.updatePushToken('b', token);
      expect(tokens).toEqual({ a: null, b: token, c: OTHER_PHONE });
    },
  );

  // Two registrations of one token at the same moment can only be raced on a
  // real Postgres. This proves the order that closes it: the token's lock is
  // taken first, inside the transaction, with the token passed as a parameter.
  it('locks the token before the handover, inside the transaction', async () => {
    const { service, calls } = world({ a: PHONE, b: null });
    await service.updatePushToken('b', PHONE);
    expect(calls).toEqual([
      `SELECT pg_advisory_xact_lock(hashtext(?)) [expo_push_token:${PHONE}]`,
      `clear ${PHONE}`,
      'set b',
    ]);
  });

  it('re-registering the same phone on the same account keeps it', async () => {
    const tokens = { a: PHONE };
    await world(tokens).service.updatePushToken('a', PHONE);
    expect(tokens).toEqual({ a: PHONE });
  });

  it('null clears only the caller, with no lock and no handover', async () => {
    const tokens = { a: PHONE, c: OTHER_PHONE };
    const { service, calls } = world(tokens);
    await service.updatePushToken('a', null);
    expect(tokens).toEqual({ a: null, c: OTHER_PHONE });
    expect(calls).toEqual(['set a']);
  });
});

describe('UpdatePushTokenDto', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const parse = (body: Record<string, unknown>) =>
    pipe.transform(body, { type: 'body', metatype: UpdatePushTokenDto });

  it.each([PHONE, 'ExpoPushToken[abcdefghijklmnopqrstuv]', UUID_TOKEN])(
    'accepts %s',
    async (token) => {
      await expect(parse({ token })).resolves.toMatchObject({ token });
    },
  );

  it('accepts null, which clears', async () => {
    await expect(parse({ token: null })).resolves.toMatchObject({ token: null });
  });

  it.each([
    '',
    'not-a-token',
    'ExponentPushToken[]',
    'exponentpushtoken[abcdefghijklmnopqrstuv]',
    `${PHONE} `,
    'F5741A13-BCDA-434B-A316',
    42,
  ])('rejects %p with a 400', async (token) => {
    await expect(parse({ token })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a token over 255 characters with a 400', async () => {
    const token = `ExponentPushToken[${'a'.repeat(240)}]`;
    await expect(parse({ token })).rejects.toBeInstanceOf(BadRequestException);
  });
});
