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

type Data = { expo_push_token: string | null };

// In-memory User table (user id -> expo_push_token) behind a transaction.
function serviceWith(tokens: Record<string, string | null>) {
  const user = {
    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: { expo_push_token: string; id: { not: string } };
        data: Data;
      }) => {
        const ids = Object.keys(tokens).filter(
          (id) => tokens[id] === where.expo_push_token && id !== where.id.not,
        );
        for (const id of ids) tokens[id] = data.expo_push_token;
        return { count: ids.length };
      },
    ),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Data }) => {
      tokens[where.id] = data.expo_push_token;
    }),
  };
  const db = {
    user,
    $transaction: jest.fn(async (fn: (tx: { user: typeof user }) => unknown) => fn({ user })),
  };
  return new UsersService(Object.create(db));
}

describe('UsersService.updatePushToken', () => {
  it('registering a phone on account B takes it off account A', async () => {
    const tokens = { a: PHONE, b: null, c: OTHER_PHONE };
    await serviceWith(tokens).updatePushToken('b', PHONE);
    expect(tokens).toEqual({ a: null, b: PHONE, c: OTHER_PHONE });
  });

  it('re-registering the same phone on the same account keeps it', async () => {
    const tokens = { a: PHONE };
    await serviceWith(tokens).updatePushToken('a', PHONE);
    expect(tokens).toEqual({ a: PHONE });
  });

  it('null clears only the caller', async () => {
    const tokens = { a: PHONE, c: OTHER_PHONE };
    await serviceWith(tokens).updatePushToken('a', null);
    expect(tokens).toEqual({ a: null, c: OTHER_PHONE });
  });
});

describe('UpdatePushTokenDto', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const parse = (body: Record<string, unknown>) =>
    pipe.transform(body, { type: 'body', metatype: UpdatePushTokenDto });

  it.each([PHONE, 'ExpoPushToken[abcdefghijklmnopqrstuv]'])('accepts %s', async (token) => {
    await expect(parse({ token })).resolves.toMatchObject({ token });
  });

  it('accepts null, which clears', async () => {
    await expect(parse({ token: null })).resolves.toMatchObject({ token: null });
  });

  it.each(['', 'not-a-token', 'ExponentPushToken[]', `${PHONE} `, 42])(
    'rejects %p with a 400',
    async (token) => {
      await expect(parse({ token })).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('rejects a token over 255 characters with a 400', async () => {
    const token = `ExponentPushToken[${'a'.repeat(240)}]`;
    await expect(parse({ token })).rejects.toBeInstanceOf(BadRequestException);
  });
});
