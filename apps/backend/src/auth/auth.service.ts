import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import ms from 'ms';
import { UsersService } from '../users/users.service';
import { WalletsService } from '../wallets/wallets.service';
import { RedisService } from '../cache/redis.service';
import {
  AccessTokenPayload,
  AuthTokens,
  RefreshTokenPayload,
} from './interfaces/token-payload.interface';

const PASSWORD_SALT_ROUNDS = 10;
const REFRESH_TOKEN_REDIS_PREFIX = 'auth:refresh:';
const JWT_ALGORITHM = 'HS256';

/**
 * Hash descartável, com o mesmo custo dos hashes reais, usado quando o
 * e-mail não existe. Sem ele o login responde na hora para e-mail
 * inexistente e só depois de ~100ms para e-mail existente com senha errada
 * — diferença suficiente para enumerar quem tem conta na carteira sem
 * precisar de nenhuma credencial válida.
 */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  'timing-attack-placeholder',
  PASSWORD_SALT_ROUNDS,
);

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly walletsService: WalletsService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {}

  async register(email: string, password: string) {
    const existing = await this.usersService.findByEmail(email);
    if (existing) {
      throw new ConflictException('E-mail já cadastrado');
    }

    const passwordHash = await bcrypt.hash(password, PASSWORD_SALT_ROUNDS);
    const user = await this.usersService.create(email, passwordHash);
    await this.walletsService.createForUser(user.id);

    return { id: user.id, email: user.email };
  }

  async login(email: string, password: string): Promise<AuthTokens> {
    const user = await this.usersService.findByEmail(email);

    // A comparação roda mesmo sem usuário (contra o hash descartável), para
    // que o tempo de resposta não denuncie se o e-mail existe ou não.
    const passwordMatches = await bcrypt.compare(
      password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );

    if (!user || !passwordMatches) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    return this.issueTokens(user.id, user.email);
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const payload = this.verifyRefreshToken(refreshToken);

    const redisKey = `${REFRESH_TOKEN_REDIS_PREFIX}${payload.jti}`;
    const storedUserId = await this.redisService.get(redisKey);
    if (!storedUserId || storedUserId !== payload.sub) {
      throw new UnauthorizedException('Refresh token inválido ou já utilizado');
    }

    // Rotação: o token usado é invalidado antes de emitir o novo par.
    await this.redisService.del(redisKey);

    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('Usuário não encontrado');
    }

    return this.issueTokens(user.id, user.email);
  }

  async logout(refreshToken: string): Promise<void> {
    const payload = this.verifyRefreshToken(refreshToken);
    await this.redisService.del(`${REFRESH_TOKEN_REDIS_PREFIX}${payload.jti}`);
  }

  /** Validade do refresh token em ms — usada como `maxAge` do cookie
   * httpOnly, para que ele expire junto com o token que carrega. */
  getRefreshTokenTtlMs(): number {
    return (
      this.toSeconds(
        this.configService.get<string>('JWT_REFRESH_EXPIRES_IN', '7d'),
      ) * 1000
    );
  }

  private async issueTokens(
    userId: string,
    email: string,
  ): Promise<AuthTokens> {
    const accessExpiresInSeconds = this.toSeconds(
      this.configService.get<string>('JWT_ACCESS_EXPIRES_IN', '15m'),
    );
    const accessPayload: AccessTokenPayload = { sub: userId, email };
    const accessToken = await this.jwtService.signAsync(accessPayload, {
      secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: accessExpiresInSeconds,
      algorithm: JWT_ALGORITHM,
    });

    const jti = randomUUID();
    const refreshExpiresInSeconds = this.toSeconds(
      this.configService.get<string>('JWT_REFRESH_EXPIRES_IN', '7d'),
    );
    const refreshPayload: RefreshTokenPayload = { sub: userId, jti };
    const refreshToken = await this.jwtService.signAsync(refreshPayload, {
      secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
      expiresIn: refreshExpiresInSeconds,
      algorithm: JWT_ALGORITHM,
    });

    await this.redisService.set(
      `${REFRESH_TOKEN_REDIS_PREFIX}${jti}`,
      userId,
      refreshExpiresInSeconds,
    );

    return { accessToken, refreshToken };
  }

  private toSeconds(duration: string): number {
    return Math.floor(ms(duration as Parameters<typeof ms>[0]) / 1000);
  }

  private verifyRefreshToken(refreshToken: string): RefreshTokenPayload {
    try {
      return this.jwtService.verify<RefreshTokenPayload>(refreshToken, {
        secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
        // Fixar o algoritmo impede que um token forjado com outro `alg` no
        // header seja aceito pela biblioteca.
        algorithms: [JWT_ALGORITHM],
      });
    } catch {
      throw new UnauthorizedException('Refresh token inválido ou expirado');
    }
  }
}
