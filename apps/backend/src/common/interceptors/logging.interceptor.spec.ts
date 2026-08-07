import { CallHandler, ExecutionContext } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { LoggingInterceptor, REQUEST_ID_HEADER } from './logging.interceptor';

function createContext(headers: Record<string, string> = {}) {
  const request = { method: 'GET', originalUrl: '/api/v1/wallets', headers };
  const response = { statusCode: 200, setHeader: jest.fn() };

  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;

  return { context, request, response };
}

describe('LoggingInterceptor', () => {
  let interceptor: LoggingInterceptor;

  beforeEach(() => {
    interceptor = new LoggingInterceptor();
  });

  it('generates a request id when none is provided and sets it on the response', (done) => {
    const { context, request, response } = createContext();
    const handler: CallHandler = { handle: () => of('ok') };

    interceptor.intercept(context, handler).subscribe(() => {
      expect(request.headers[REQUEST_ID_HEADER]).toEqual(expect.any(String));
      expect(response.setHeader).toHaveBeenCalledWith(
        REQUEST_ID_HEADER,
        request.headers[REQUEST_ID_HEADER],
      );
      done();
    });
  });

  it('reuses the incoming request id instead of generating a new one', (done) => {
    const { context, request, response } = createContext({
      [REQUEST_ID_HEADER]: 'existing-id',
    });
    const handler: CallHandler = { handle: () => of('ok') };

    interceptor.intercept(context, handler).subscribe(() => {
      expect(request.headers[REQUEST_ID_HEADER]).toBe('existing-id');
      expect(response.setHeader).toHaveBeenCalledWith(
        REQUEST_ID_HEADER,
        'existing-id',
      );
      done();
    });
  });

  it('propagates errors from the handler without swallowing them', (done) => {
    const { context } = createContext();
    const error = new Error('falha no handler');
    const handler: CallHandler = { handle: () => throwError(() => error) };

    interceptor.intercept(context, handler).subscribe({
      error: (err) => {
        expect(err).toBe(error);
        done();
      },
    });
  });
});
