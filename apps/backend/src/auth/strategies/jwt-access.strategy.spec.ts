import { ConfigService } from '@nestjs/config';
import { JwtAccessStrategy } from './jwt-access.strategy';

describe('JwtAccessStrategy', () => {
  it('maps the JWT payload to { userId, email }', () => {
    const configService = {
      getOrThrow: jest.fn().mockReturnValue('access-secret'),
    } as unknown as ConfigService;

    const strategy = new JwtAccessStrategy(configService);

    const result = strategy.validate({
      sub: 'user-1',
      email: 'user@example.com',
    });

    expect(result).toEqual({ userId: 'user-1', email: 'user@example.com' });
  });
});
