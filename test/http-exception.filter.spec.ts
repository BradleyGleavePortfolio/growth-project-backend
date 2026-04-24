import {
  BadRequestException,
  HttpStatus,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';

// Round-5: global error-shape standardization to
// { statusCode, message, error, timestamp, path }.
// The mobile client only reads `err.response?.data?.message`, so the extra
// fields are additive. Explicit tests pin each field so a future refactor
// can't silently change the contract.
describe('HttpExceptionFilter', () => {
  const buildHost = (url = '/api/foo', method = 'POST') => {
    const statusMock = jest.fn().mockReturnThis();
    const jsonMock = jest.fn();
    return {
      responseMock: { status: statusMock, json: jsonMock },
      statusMock,
      jsonMock,
      host: {
        switchToHttp: () => ({
          getResponse: () => ({ status: statusMock, json: jsonMock }),
          getRequest: () => ({ url, method }),
        }),
      } as any,
    };
  };

  it('serializes NotFoundException with the documented shape', () => {
    const filter = new HttpExceptionFilter();
    const { host, statusMock, jsonMock } = buildHost('/api/log/food/x');
    filter.catch(new NotFoundException('Entry not found'), host);

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    const body = jsonMock.mock.calls[0][0];
    expect(body).toMatchObject({
      statusCode: 404,
      message: 'Entry not found',
      error: 'Not Found',
      path: '/api/log/food/x',
    });
    expect(typeof body.timestamp).toBe('string');
  });

  it('preserves ValidationPipe message arrays from BadRequestException', () => {
    const filter = new HttpExceptionFilter();
    const { host, jsonMock } = buildHost('/api/workouts');
    filter.catch(
      new BadRequestException(['name must be shorter than 200 characters']),
      host,
    );

    const body = jsonMock.mock.calls[0][0];
    expect(body.statusCode).toBe(400);
    expect(body.message).toEqual(['name must be shorter than 200 characters']);
    expect(body.error).toBe('Bad Request');
  });

  it('maps ForbiddenException correctly', () => {
    const filter = new HttpExceptionFilter();
    const { host, jsonMock, statusMock } = buildHost('/api/lessons');
    filter.catch(new ForbiddenException('Coach access required'), host);

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    const body = jsonMock.mock.calls[0][0];
    expect(body).toMatchObject({
      statusCode: 403,
      message: 'Coach access required',
      error: 'Forbidden',
      path: '/api/lessons',
    });
  });

  it('returns a sanitized 500 for non-HttpException errors without leaking internals', () => {
    const filter = new HttpExceptionFilter();
    // Suppress the logger noise this test intentionally triggers.
    const loggerSpy = jest
      .spyOn((filter as any).logger, 'error')
      .mockImplementation(() => undefined);
    const { host, jsonMock, statusMock } = buildHost('/api/boom');

    filter.catch(new Error('db password: hunter2'), host);

    expect(statusMock).toHaveBeenCalledWith(500);
    const body = jsonMock.mock.calls[0][0];
    expect(body.statusCode).toBe(500);
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(loggerSpy).toHaveBeenCalled();
  });
});
