import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { AbacatePayService } from './abacatepay.service';

describe('AbacatePayService', () => {
  let service: AbacatePayService;
  let configService: Record<'getOrThrow', jest.Mock>;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    configService = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'ABACATEPAY_BASE_URL')
          return 'https://api.abacatepay.com/v2';
        if (key === 'ABACATEPAY_API_KEY') return 'test-key';
        throw new Error(`unexpected key ${key}`);
      }),
    };
    service = new AbacatePayService(configService as unknown as ConfigService);
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const jsonResponse = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'error',
    json: () => Promise.resolve(body),
  });

  describe('createProduct', () => {
    it('posts to /products/create and returns data', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          success: true,
          data: { id: 'prod_1' },
          error: null,
        }),
      );

      const result = await service.createProduct('ext-1', 'Depósito', 1000);

      expect(result).toEqual({ id: 'prod_1' });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.abacatepay.com/v2/products/create',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-key',
          }),
          body: JSON.stringify({
            externalId: 'ext-1',
            name: 'Depósito',
            price: 1000,
            currency: 'BRL',
          }),
        }),
      );
    });
  });

  describe('createPixCheckout', () => {
    it('posts to /checkouts/create with PIX method', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          success: true,
          data: {
            id: 'checkout_1',
            url: 'https://pay.example/checkout_1',
            status: 'PENDING',
          },
          error: null,
        }),
      );

      const result = await service.createPixCheckout(
        'prod_1',
        'https://app.example/return',
        'https://app.example/complete',
      );

      expect(result).toEqual({
        id: 'checkout_1',
        url: 'https://pay.example/checkout_1',
        status: 'PENDING',
      });
      const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(requestInit.body as string);
      expect(body).toEqual({
        items: [{ id: 'prod_1', quantity: 1 }],
        methods: ['PIX'],
        returnUrl: 'https://app.example/return',
        completionUrl: 'https://app.example/complete',
      });
    });
  });

  describe('findCheckoutById', () => {
    it('lists checkouts and returns the matching one', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          success: true,
          data: [
            { id: 'checkout_1', url: 'https://pay.example/1', status: 'PAID' },
            {
              id: 'checkout_2',
              url: 'https://pay.example/2',
              status: 'PENDING',
            },
          ],
          error: null,
        }),
      );

      const result = await service.findCheckoutById('checkout_2');

      expect(result).toEqual({
        id: 'checkout_2',
        url: 'https://pay.example/2',
        status: 'PENDING',
      });
    });

    it('returns null when no checkout matches the id', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { success: true, data: [], error: null }),
      );

      const result = await service.findCheckoutById('missing');

      expect(result).toBeNull();
    });
  });

  describe('error handling', () => {
    it('throws HttpException when the envelope reports failure', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(400, {
          success: false,
          data: null,
          error: 'CARD is not available for this store',
        }),
      );

      await expect(
        service.createProduct('ext-1', 'Depósito', 1000),
      ).rejects.toThrow(HttpException);
    });

    it('throws HttpException when the HTTP response is not ok even if success is true', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(502, { success: true, data: null, error: null }),
      );

      await expect(service.findCheckoutById('x')).rejects.toThrow(
        HttpException,
      );
    });
  });
});
