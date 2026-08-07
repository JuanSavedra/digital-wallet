import { ArgumentsHost, BadRequestException, HttpStatus } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

function createHost(request: Record<string, unknown>) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const response = { status };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  return { host, status, json };
}

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
  });

  it('maps an HttpException to its status code and message', () => {
    const { host, status, json } = createHost({
      url: '/api/v1/wallets',
      headers: {},
    });

    filter.catch(new BadRequestException('saldo insuficiente'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.BAD_REQUEST,
        path: '/api/v1/wallets',
        message: 'saldo insuficiente',
      }),
    );
  });

  it('maps an unknown error to 500 without leaking the internal message', () => {
    const { host, status, json } = createHost({
      url: '/api/v1/wallets',
      headers: {},
    });

    filter.catch(new Error('conexão perdida com o banco'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Internal server error',
      }),
    );
  });

  it('echoes back the incoming request id when present', () => {
    const { host, json } = createHost({
      url: '/api/v1/wallets',
      headers: { 'x-request-id': 'req-123' },
    });

    filter.catch(new BadRequestException('erro'), host);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-123' }),
    );
  });
});
