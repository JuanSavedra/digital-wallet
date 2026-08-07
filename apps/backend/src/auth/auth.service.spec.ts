import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { RedisService } from '../cache/redis.service';
import { UsersService } from '../users/users.service';
import { WalletsService } from '../wallets/wallets.service';

// Fábrica em vez do auto-mock: `auth.service.ts` chama `hashSync` no
// carregamento do módulo para montar o hash descartável do login, e o
// auto-mock devolveria `undefined` ali.
jest.mock('bcrypt', () => ({
  hash: jest.fn(),
  hashSync: jest.fn(() => '$2b$10$dummy-hash-para-teste'),
  compare: jest.fn(),
}));

describe('AuthService', () => {
  let authService: AuthService;
  let usersService: jest.Mocked<UsersService>;
  let walletsService: jest.Mocked<WalletsService>;
  let jwtService: jest.Mocked<JwtService>;
  let redisService: jest.Mocked<RedisService>;

  const user = {
    id: 'user-1',
    email: 'user@example.com',
    passwordHash: 'hashed-password',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const envDefaults: Record<string, string> = {
    JWT_ACCESS_SECRET: 'access-secret',
    JWT_ACCESS_EXPIRES_IN: '15m',
    JWT_REFRESH_SECRET: 'refresh-secret',
    JWT_REFRESH_EXPIRES_IN: '7d',
  };

  beforeEach(() => {
    usersService = {
      findByEmail: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
    } as unknown as jest.Mocked<UsersService>;

    walletsService = {
      createForUser: jest.fn(),
    } as unknown as jest.Mocked<WalletsService>;

    jwtService = {
      signAsync: jest.fn(),
      verify: jest.fn(),
    } as unknown as jest.Mocked<JwtService>;

    redisService = {
      set: jest.fn(),
      get: jest.fn(),
      del: jest.fn(),
    } as unknown as jest.Mocked<RedisService>;

    const configService = {
      get: jest.fn(
        (key: string, defaultValue?: string) =>
          envDefaults[key] ?? defaultValue,
      ),
      getOrThrow: jest.fn((key: string) => {
        const value = envDefaults[key];
        if (!value) throw new Error(`missing ${key}`);
        return value;
      }),
    } as unknown as ConfigService;

    authService = new AuthService(
      usersService,
      walletsService,
      jwtService,
      configService,
      redisService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  describe('register', () => {
    it('hashes the password, creates the user and provisions a wallet', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      (bcrypt.hash as jest.Mock).mockResolvedValue('hashed-password');
      usersService.create.mockResolvedValue(user);

      const result = await authService.register(
        'user@example.com',
        'plain-password',
      );

      expect(bcrypt.hash).toHaveBeenCalledWith('plain-password', 10);
      expect(usersService.create).toHaveBeenCalledWith(
        'user@example.com',
        'hashed-password',
      );
      expect(walletsService.createForUser).toHaveBeenCalledWith(user.id);
      expect(result).toEqual({ id: user.id, email: user.email });
    });

    it('throws ConflictException when the email is already registered', async () => {
      usersService.findByEmail.mockResolvedValue(user);

      await expect(
        authService.register('user@example.com', 'plain-password'),
      ).rejects.toThrow(ConflictException);
      expect(usersService.create).not.toHaveBeenCalled();
      expect(walletsService.createForUser).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('issues an access/refresh pair and stores the refresh jti in redis', async () => {
      usersService.findByEmail.mockResolvedValue(user);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      jwtService.signAsync
        .mockResolvedValueOnce('access-token')
        .mockResolvedValueOnce('refresh-token');

      const result = await authService.login(
        'user@example.com',
        'plain-password',
      );

      expect(result).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      });
      expect(redisService.set).toHaveBeenCalledWith(
        expect.stringMatching(/^auth:refresh:/),
        user.id,
        expect.any(Number),
      );
    });

    it('throws UnauthorizedException when the user does not exist', async () => {
      usersService.findByEmail.mockResolvedValue(null);

      await expect(
        authService.login('missing@example.com', 'whatever'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('still runs bcrypt.compare for an unknown email, so response time does not reveal who has an account', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      (bcrypt.compare as jest.Mock).mockClear();
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        authService.login('missing@example.com', 'whatever'),
      ).rejects.toThrow(UnauthorizedException);

      // Sem esta comparação contra o hash descartável, o login responderia
      // na hora para e-mail inexistente e só depois de ~100ms para e-mail
      // existente — diferença suficiente para enumerar as contas da carteira.
      expect(bcrypt.compare).toHaveBeenCalledTimes(1);
      expect(bcrypt.compare).toHaveBeenCalledWith(
        'whatever',
        expect.stringMatching(/^\$2[aby]\$/),
      );
    });

    it('gives the same message for unknown email and wrong password', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      const unknownEmail = await authService
        .login('missing@example.com', 'whatever')
        .catch((error: Error) => error.message);

      usersService.findByEmail.mockResolvedValue(user);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      const wrongPassword = await authService
        .login('user@example.com', 'wrong')
        .catch((error: Error) => error.message);

      expect(unknownEmail).toBe(wrongPassword);
    });

    it('throws UnauthorizedException when the password does not match', async () => {
      usersService.findByEmail.mockResolvedValue(user);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        authService.login('user@example.com', 'wrong-password'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('refresh', () => {
    const refreshPayload = { sub: user.id, jti: 'jti-1' };

    it('rotates the refresh token: invalidates the old jti and issues a new pair', async () => {
      jwtService.verify.mockReturnValue(refreshPayload);
      redisService.get.mockResolvedValue(user.id);
      usersService.findById.mockResolvedValue(user);
      jwtService.signAsync
        .mockResolvedValueOnce('new-access-token')
        .mockResolvedValueOnce('new-refresh-token');

      const result = await authService.refresh('old-refresh-token');

      expect(redisService.del).toHaveBeenCalledWith('auth:refresh:jti-1');
      expect(result).toEqual({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
      });
    });

    it('rejects a refresh token whose jti is not in redis (already used or expired)', async () => {
      jwtService.verify.mockReturnValue(refreshPayload);
      redisService.get.mockResolvedValue(null);

      await expect(authService.refresh('old-refresh-token')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(redisService.del).not.toHaveBeenCalled();
    });

    it('rejects a token that fails signature/expiry verification', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('invalid signature');
      });

      await expect(authService.refresh('garbage')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('logout', () => {
    it('deletes the refresh jti from redis', async () => {
      jwtService.verify.mockReturnValue({ sub: user.id, jti: 'jti-1' });

      await authService.logout('refresh-token');

      expect(redisService.del).toHaveBeenCalledWith('auth:refresh:jti-1');
    });
  });
});
